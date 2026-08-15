import { serializeCanonicalJson, type CanonicalJson } from './canonical-json.js'
import {
  EndpointIdentityInvariantError,
  normalizeNodeEndpointIdentityQualification,
  validateEndpointIdentityEndpointQualification,
  type EndpointIdentityEndpointQualification,
} from './endpoint-identity.js'
import {
  createEvidenceOccurrence,
  createSemanticFact,
  type EvidenceOccurrenceDraft,
} from './semantic-identity.js'
import {
  isRegisteredRelation,
  resolveRelationDiscriminator,
  type SemanticDiscriminator,
} from './relation-discriminator.js'
import type {
  EvidenceOccurrence,
  EvidenceOccurrenceId,
  EvidenceProvenance,
  SemanticFact,
  SemanticFactId,
} from './semantic-graph.js'

export type GraphAttributes = Record<string, unknown>

export type GraphRelationshipView = Readonly<GraphAttributes>

export type GraphRelationshipEntry = readonly [
  source: string,
  target: string,
  attributes: GraphRelationshipView,
]

/**
 * Minimal storage-boundary admission diagnostic for PR B. It proves an
 * admission was attempted and refused without inventing a source, target,
 * topology entry or occurrence. #658 owns the full terminal-state records.
 */
export interface StorageBoundaryAdmissionSummary {
  readonly unresolvedUnregisteredRelationCandidates: number
  readonly unregisteredRelationCounts: Readonly<Record<string, number>>
}

export interface GraphEndpointEntry {
  readonly source: string
  readonly target: string
}

export interface FactsBetweenOptions {
  readonly relations?: readonly string[]
}

export interface KnowledgeGraphOptions {
  directed?: boolean
}

interface StoredFact {
  fact: SemanticFact
  attributes: GraphAttributes
}

interface EndpointPairIndexEntry {
  readonly source: string
  readonly target: string
  readonly factIds: Set<SemanticFactId>
}

export interface GraphFactRecord {
  readonly fact: SemanticFact
  readonly attributes: GraphRelationshipView
}

export interface GraphAddEdgeOptions {
  readonly discriminator?: SemanticDiscriminator
  readonly recordOccurrence?: boolean
  readonly occurrence?: EvidenceOccurrenceDraft
  /** @internal Only the artifact compatibility loader may admit legacy discriminators. */
  readonly legacyCompatibility?: 'v1-artifact-loader'
}

export type GraphEdgeAdmissionResult =
  | Readonly<{
    status: 'stored'
    factId: SemanticFactId
    duplicate: boolean
    occurrenceId?: EvidenceOccurrenceId
  }>
  | Readonly<{
    status: 'unresolved_degraded'
    relation: string
    reasons: readonly ['relation_not_registered']
  }>

/**
 * Module-private capability for the artifact loader. The symbol is not
 * exported, so the hydration entry points are unreachable from other modules
 * even though they are public members.
 */
const ARTIFACT_HYDRATION_TOKEN: unique symbol = Symbol('madar.artifact-hydration')

function assertHydrationToken(token: symbol): void {
  if (token !== ARTIFACT_HYDRATION_TOKEN) {
    throw new GraphAdmissionError('Verified hydration is reserved for the artifact loader')
  }
}

/** @internal Obtainable only by the artifact loader inside this package. */
export function artifactHydrationToken(caller: 'graph-artifact-loader'): symbol {
  if (caller !== 'graph-artifact-loader') {
    throw new GraphAdmissionError('Verified hydration is reserved for the artifact loader')
  }
  return ARTIFACT_HYDRATION_TOKEN
}

export class GraphAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphAdmissionError'
  }
}

export class MissingGraphEndpointError extends GraphAdmissionError {
  readonly endpointIds: readonly string[]

  constructor(endpointIds: readonly string[]) {
    super(`Cannot admit semantic fact: missing endpoint${endpointIds.length === 1 ? '' : 's'} ${endpointIds.map((id) => JSON.stringify(id)).join(', ')}`)
    this.name = 'MissingGraphEndpointError'
    this.endpointIds = Object.freeze([...endpointIds])
  }
}

export class InvalidGraphEndpointQualificationError extends GraphAdmissionError {
  readonly endpointId: string

  constructor(endpointId: string, cause?: unknown) {
    super(`Cannot admit semantic fact: endpoint ${JSON.stringify(endpointId)} has invalid identity qualification`)
    this.name = 'InvalidGraphEndpointQualificationError'
    this.endpointId = endpointId
    if (cause !== undefined) this.cause = cause
  }
}

export class AmbiguousEdgeError extends GraphAdmissionError {
  readonly source: string
  readonly target: string
  readonly factIds: readonly SemanticFactId[]

  constructor(source: string, target: string, factIds: readonly SemanticFactId[]) {
    super(`Ambiguous edge: ${source} -> ${target} has ${factIds.length} semantic facts`)
    this.name = 'AmbiguousEdgeError'
    this.source = source
    this.target = target
    this.factIds = Object.freeze([...factIds])
  }
}

export class MissingSemanticFactError extends GraphAdmissionError {
  readonly factId: SemanticFactId

  constructor(factId: SemanticFactId) {
    super(`Cannot admit evidence occurrence: unknown semantic fact ${factId}`)
    this.name = 'MissingSemanticFactError'
    this.factId = factId
  }
}

export class InvalidEvidenceOccurrenceError extends GraphAdmissionError {
  constructor(message: string) {
    super(`Cannot admit evidence occurrence: ${message}`)
    this.name = 'InvalidEvidenceOccurrenceError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSourceRange(value: unknown): value is NonNullable<EvidenceOccurrenceDraft['sourceRange']> {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return false
  return typeof value.start.line === 'number'
    && Number.isFinite(value.start.line)
    && typeof value.start.column === 'number'
    && Number.isFinite(value.start.column)
    && typeof value.end.line === 'number'
    && Number.isFinite(value.end.line)
    && typeof value.end.column === 'number'
    && Number.isFinite(value.end.column)
}

function repositoryRelativeFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    return undefined
  }
  return normalized
}

function canonicalUnion<T>(left: readonly T[], right: readonly T[]): readonly T[] {
  const values = new Map<string, T>()
  for (const value of [...left, ...right]) {
    values.set(serializeCanonicalJson(value, { arraySemantics: 'ordered' }), value)
  }
  return Object.freeze([...values.entries()].sort(([leftKey], [rightKey]) => (
    leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  )).map(([, value]) => value))
}

function canonicalChoice<T>(left: T, right: T): T {
  const leftKey = serializeCanonicalJson(left as CanonicalJson, { arraySemantics: 'ordered' })
  const rightKey = serializeCanonicalJson(right as CanonicalJson, { arraySemantics: 'ordered' })
  return leftKey <= rightKey ? left : right
}

function functionValuePath(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): string | null {
  if (typeof value === 'function') {
    return path
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return null
  }
  seen.add(value)

  if (
    value instanceof Date
    || ArrayBuffer.isView(value)
    || value instanceof ArrayBuffer
    || value instanceof SharedArrayBuffer
  ) {
    return null
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = functionValuePath(value[index], `${path}[${index}]`, seen)
      if (match !== null) {
        return match
      }
    }
    return null
  }
  if (value instanceof Map) {
    let index = 0
    for (const [key, item] of value) {
      const keyMatch = functionValuePath(key, `${path}.<map-key:${index}>`, seen)
      if (keyMatch !== null) {
        return keyMatch
      }
      const valueMatch = functionValuePath(item, `${path}.<map-value:${index}>`, seen)
      if (valueMatch !== null) {
        return valueMatch
      }
      index += 1
    }
    return null
  }
  if (value instanceof Set) {
    let index = 0
    for (const item of value) {
      const match = functionValuePath(item, `${path}.<set-value:${index}>`, seen)
      if (match !== null) {
        return match
      }
      index += 1
    }
    return null
  }

  for (const [key, item] of Object.entries(value)) {
    const match = functionValuePath(item, path ? `${path}.${key}` : key, seen)
    if (match !== null) {
      return match
    }
  }
  return null
}

function assertGraphAttributesWritable(attributes: GraphAttributes): void {
  const offendingKey = functionValuePath(attributes, '')
  if (offendingKey !== null) {
    throw new TypeError(`Graph attribute "${offendingKey}" cannot contain a function value`)
  }
}

function isolatedArrayBufferView(value: ArrayBufferView): ArrayBufferView {
  if (!(value.buffer instanceof SharedArrayBuffer)) {
    return structuredClone(value)
  }

  const buffer = new ArrayBuffer(value.buffer.byteLength)
  new Uint8Array(buffer).set(new Uint8Array(value.buffer))
  if (value instanceof DataView) {
    return new DataView(buffer, value.byteOffset, value.byteLength)
  }

  const TypedArray = value.constructor as new (
    buffer: ArrayBuffer,
    byteOffset: number,
    length: number,
  ) => ArrayBufferView
  const bytesPerElement = (value as unknown as { readonly BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
  return new TypedArray(buffer, value.byteOffset, value.byteLength / bytesPerElement)
}

/**
 * Builds a detached projection of supported graph values. Functions are refused because an
 * arbitrary closure cannot be cloned without retaining live state from the stored value.
 */
function immutableGraphValue(value: unknown, clones = new WeakMap<object, unknown>()): unknown {
  if (typeof value === 'function') {
    throw new TypeError('Cannot create an immutable graph projection for a function-valued attribute')
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  const existing = clones.get(value)
  if (existing !== undefined) {
    return existing
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = []
    clones.set(value, clone)
    clone.push(...value.map((item) => immutableGraphValue(item, clones)))
    return Object.freeze(clone)
  }

  if (value instanceof Date) {
    const clone = new Date(value)
    clones.set(value, clone)
    return clone
  }

  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>()
    clones.set(value, clone)
    for (const [key, item] of value) {
      clone.set(immutableGraphValue(key, clones), immutableGraphValue(item, clones))
    }
    return clone
  }

  if (value instanceof Set) {
    const clone = new Set<unknown>()
    clones.set(value, clone)
    for (const item of value) {
      clone.add(immutableGraphValue(item, clones))
    }
    return clone
  }

  if (ArrayBuffer.isView(value)) {
    const clone = isolatedArrayBufferView(value)
    clones.set(value, clone)
    return clone
  }

  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0)
    clones.set(value, clone)
    return clone
  }

  if (value instanceof SharedArrayBuffer) {
    const clone = new ArrayBuffer(value.byteLength)
    new Uint8Array(clone).set(new Uint8Array(value))
    clones.set(value, clone)
    return clone
  }

  const clone: Record<string, unknown> = {}
  clones.set(value, clone)
  for (const [key, item] of Object.entries(value)) {
    clone[key] = immutableGraphValue(item, clones)
  }
  return Object.freeze(clone)
}

function immutableGraphAttributes(attributes: GraphAttributes): GraphRelationshipView {
  return immutableGraphValue(attributes) as GraphRelationshipView
}

export class KnowledgeGraph {
  public readonly graph: GraphAttributes = {}
  public readonly directed: boolean

  private readonly nodeMap = new Map<string, GraphAttributes>()
  private readonly nodeEndpointIdentityMap = new Map<string, EndpointIdentityEndpointQualification>()
  private readonly factMap = new Map<SemanticFactId, StoredFact>()
  private readonly occurrenceMap = new Map<EvidenceOccurrenceId, EvidenceOccurrence>()
  private readonly sourceFactIndex = new Map<string, Set<SemanticFactId>>()
  private readonly targetFactIndex = new Map<string, Set<SemanticFactId>>()
  private readonly relationFactIndex = new Map<string, Set<SemanticFactId>>()
  private readonly endpointPairIndex = new Map<string, EndpointPairIndexEntry>()
  private readonly factOccurrenceIndex = new Map<SemanticFactId, Set<EvidenceOccurrenceId>>()
  private readonly successorMap = new Map<string, Set<string>>()
  private readonly predecessorMap = new Map<string, Set<string>>()
  /**
   * Counts unregistered relations refused at the storage boundary, keyed by
   * relation. Recorded here rather than left to the caller: the original defect
   * was that `addEdge` returned an accurate refusal and every caller ignored it,
   * so five producer relations vanished with no trace anywhere in the system.
   * This is a storage-boundary diagnostic, not a graph fact -- it creates no
   * node, pair, occurrence or traversable edge. Exact terminal accounting for
   * unresolved candidates remains #658's responsibility.
   */
  private readonly unregisteredRelationAdmissions = new Map<string, number>()
  /** Invalidated by every endpoint-pair mutation; see endpointEntries(). */
  private endpointEntriesCache: readonly GraphEndpointEntry[] | null = null

  constructor(options: KnowledgeGraphOptions | boolean = {}) {
    this.directed = typeof options === 'boolean' ? options : options.directed === true
    this.graph.directed = this.directed
  }

  private edgeKey(source: string, target: string): string {
    if (this.directed) {
      return `${source}\u0000${target}`
    }
    return [source, target].sort().join('\u0000')
  }

  addNode(id: string, attributes: GraphAttributes): void {
    assertGraphAttributesWritable(attributes)
    const qualification = normalizeNodeEndpointIdentityQualification(attributes)
    const { endpointIdentity: _endpointIdentity, ...storedAttributes } = attributes
    this.nodeMap.set(id, storedAttributes)
    this.nodeEndpointIdentityMap.set(id, qualification)
    if (!this.successorMap.has(id)) {
      this.successorMap.set(id, new Set())
    }
    if (!this.predecessorMap.has(id)) {
      this.predecessorMap.set(id, new Set())
    }
  }

  /**
   * The single place fact storage and every index are updated.
   *
   * Shared by normal admission and artifact hydration so the two cannot drift:
   * a loaded graph and a generated graph must be index-for-index identical.
   * It takes an already-constructed fact and derives no identity.
   */
  private indexVerifiedFact(fact: SemanticFact, attributes: GraphAttributes): void {
    this.factMap.set(fact.id, { fact, attributes: { ...attributes } })
    this.addFactIndexEntry(this.sourceFactIndex, fact.source, fact.id)
    this.addFactIndexEntry(this.targetFactIndex, fact.target, fact.id)
    this.addFactIndexEntry(this.relationFactIndex, fact.relation, fact.id)
    if (!this.factOccurrenceIndex.has(fact.id)) this.factOccurrenceIndex.set(fact.id, new Set())

    const pairKey = this.edgeKey(fact.source, fact.target)
    const pairEntry = this.endpointPairIndex.get(pairKey)
    if (pairEntry === undefined) {
      this.endpointPairIndex.set(pairKey, {
        source: fact.source,
        target: fact.target,
        factIds: new Set([fact.id]),
      })
      this.endpointEntriesCache = null
    } else {
      pairEntry.factIds.add(fact.id)
    }

    this.successorMap.get(fact.source)?.add(fact.target)
    this.predecessorMap.get(fact.target)?.add(fact.source)

    if (!this.directed) {
      this.successorMap.get(fact.target)?.add(fact.source)
      this.predecessorMap.get(fact.source)?.add(fact.target)
    }
  }

  /**
   * @internal Artifact-loader only. Inserts a fact whose SemanticFactId the
   * caller has ALREADY derived from its canonical payload and compared with
   * the stored id.
   *
   * This is not "trust the stored id". The loader still derives and verifies
   * every id; this only stops `addEdge` from deriving the same id a second
   * time, which on the self-graph was 17,940 redundant SHA-256 computations
   * per load. Verifications per fact stay at exactly one.
   *
   * Guarded by a module-private token so no producer can reach it and insert
   * an arbitrary precomputed id.
   */
  hydrateVerifiedFact(token: symbol, fact: SemanticFact, attributes: GraphAttributes): void {
    assertHydrationToken(token)
    const existing = this.factMap.get(fact.id)
    if (existing !== undefined) {
      if (serializeCanonicalJson(existing.fact as unknown as CanonicalJson, { arraySemantics: 'ordered' })
        !== serializeCanonicalJson(fact as unknown as CanonicalJson, { arraySemantics: 'ordered' })) {
        throw new GraphAdmissionError(`Duplicate semantic fact id ${fact.id} carries a different payload`)
      }
      return
    }
    this.indexVerifiedFact(fact, attributes)
  }

  /**
   * @internal Artifact-loader only. Same contract as hydrateVerifiedFact, for
   * evidence occurrences.
   */
  hydrateVerifiedOccurrence(token: symbol, occurrence: EvidenceOccurrence): void {
    assertHydrationToken(token)
    if (!this.factMap.has(occurrence.factId)) throw new MissingSemanticFactError(occurrence.factId)
    const existing = this.occurrenceMap.get(occurrence.id)
    if (existing !== undefined) {
      if (serializeCanonicalJson(existing as unknown as CanonicalJson, { arraySemantics: 'ordered' })
        !== serializeCanonicalJson(occurrence as unknown as CanonicalJson, { arraySemantics: 'ordered' })) {
        throw new InvalidEvidenceOccurrenceError(`duplicate occurrence id ${occurrence.id} carries a different payload`)
      }
      return
    }
    this.occurrenceMap.set(occurrence.id, occurrence)
    const factOccurrences = this.factOccurrenceIndex.get(occurrence.factId)
    if (factOccurrences === undefined) throw new MissingSemanticFactError(occurrence.factId)
    factOccurrences.add(occurrence.id)
  }

  addEdge(
    source: string,
    target: string,
    attributes: GraphAttributes,
    options: GraphAddEdgeOptions = {},
  ): GraphEdgeAdmissionResult {
    assertGraphAttributesWritable(attributes)
    const missingEndpoints = [source, target].filter((id, index, ids) => (
      !this.nodeMap.has(id) && ids.indexOf(id) === index
    ))
    if (missingEndpoints.length > 0) {
      throw new MissingGraphEndpointError(missingEndpoints)
    }

    const endpointQualifications: EndpointIdentityEndpointQualification[] = []
    for (const endpointId of [source, target]) {
      const qualification = this.nodeEndpointIdentityMap.get(endpointId)
      try {
        endpointQualifications.push(validateEndpointIdentityEndpointQualification(qualification))
      } catch (error) {
        if (error instanceof EndpointIdentityInvariantError) {
          throw new InvalidGraphEndpointQualificationError(endpointId, error)
        }
        throw error
      }
    }

    const relation = typeof attributes.relation === 'string' ? attributes.relation : ''
    const resolution = resolveRelationDiscriminator(relation)
    const legacyDiscriminator = options.discriminator?.legacy === true ? options.discriminator : null
    if (legacyDiscriminator !== null && options.legacyCompatibility !== 'v1-artifact-loader') {
      throw new GraphAdmissionError('Legacy semantic facts may only enter through the v1 artifact compatibility path')
    }
    if (resolution.status === 'unregistered' && legacyDiscriminator === null) {
      this.unregisteredRelationAdmissions.set(
        relation,
        (this.unregisteredRelationAdmissions.get(relation) ?? 0) + 1,
      )
      return Object.freeze({
        status: 'unresolved_degraded' as const,
        relation,
        reasons: resolution.reasons,
      })
    }
    if (!isRegisteredRelation(relation) && legacyDiscriminator === null) {
      throw new GraphAdmissionError(`Registered discriminator resolution disagrees for relation ${JSON.stringify(relation)}`)
    }

    const discriminator = legacyDiscriminator
      ?? options.discriminator
      ?? (resolution.status === 'registered' ? resolution.discriminator : null)
    if (discriminator === null) {
      throw new GraphAdmissionError('Legacy discriminator resolution failed')
    }

    const fact = createSemanticFact({
      direction: this.directed ? 'directed' : 'undirected',
      source,
      target,
      relation,
      discriminator,
      endpointIdentity: {
        source: endpointQualifications[0]!,
        target: endpointQualifications[1]!,
      },
      occurrenceIds: [],
      annotations: {},
    })
    const occurrence = options.recordOccurrence === false
      ? null
      : createEvidenceOccurrence({
        factId: fact.id,
        ...(options.occurrence ?? this.compatibilityOccurrenceDraft(attributes)),
      })
    const existing = this.factMap.get(fact.id)
    if (existing !== undefined) {
      if (occurrence !== null) this.addOccurrence(occurrence)
      return Object.freeze({
        status: 'stored' as const,
        factId: fact.id,
        duplicate: true,
        ...(occurrence !== null ? { occurrenceId: occurrence.id } : {}),
      })
    }

    this.indexVerifiedFact(fact, attributes)

    if (occurrence !== null) this.addOccurrence(occurrence)

    return Object.freeze({
      status: 'stored' as const,
      factId: fact.id,
      duplicate: false,
      ...(occurrence !== null ? { occurrenceId: occurrence.id } : {}),
    })
  }

  private compatibilityOccurrenceDraft(attributes: GraphAttributes): EvidenceOccurrenceDraft {
    const sourceFile = repositoryRelativeFile(attributes.source_file)
    const targetFile = repositoryRelativeFile(attributes.target_file)
    const sourceRange = isSourceRange(attributes.source_range) ? attributes.source_range : undefined
    const targetRange = isSourceRange(attributes.target_range) ? attributes.target_range : undefined
    const adapterId = typeof attributes.adapter_id === 'string'
      ? attributes.adapter_id
      : typeof attributes.extraction_strategy === 'string'
        ? attributes.extraction_strategy
        : 'compatibility'
    const strategy = typeof attributes.extraction_strategy === 'string'
      ? attributes.extraction_strategy
      : 'unknown'
    const provenance = Array.isArray(attributes.provenance)
      ? attributes.provenance.filter((entry): entry is EvidenceProvenance => (
        isRecord(entry) && typeof entry.capability_id === 'string'
      )).map((entry) => ({ ...entry }))
      : []
    const confidence = typeof attributes.confidence === 'string' ? attributes.confidence : undefined
    const score = typeof attributes.confidence_score === 'number' && Number.isFinite(attributes.confidence_score)
      ? attributes.confidence_score
      : undefined
    const hasStableSite = sourceRange !== undefined
      || typeof attributes.adapter_evidence_key === 'string'
      || typeof attributes.source_location === 'string'

    return {
      owner: {
        adapterId,
        strategy,
        ...(sourceFile !== undefined ? { sourceFile } : {}),
        ...(typeof attributes.adapter_version === 'string' ? { adapterVersion: attributes.adapter_version } : {}),
      },
      ...(sourceFile !== undefined ? { sourceFile } : {}),
      ...(sourceRange !== undefined ? { sourceRange } : {}),
      ...(targetFile !== undefined ? { targetFile } : {}),
      ...(targetRange !== undefined ? { targetRange } : {}),
      ...(typeof attributes.site_kind === 'string' ? { siteKind: attributes.site_kind } : {}),
      ...(typeof attributes.adapter_evidence_key === 'string'
        ? { adapterEvidenceKey: attributes.adapter_evidence_key }
        : typeof attributes.source_location === 'string'
          ? { adapterEvidenceKey: attributes.source_location }
          : {}),
      provenance,
      confidenceObservations: confidence === undefined
        ? []
        : [{ confidence, ...(score !== undefined ? { score } : {}) }],
      metadata: hasStableSite
        ? {}
        : { diagnostics: ['occurrence_multiplicity_unknown'] as readonly CanonicalJson[] },
    }
  }

  addOccurrence(occurrence: EvidenceOccurrence): EvidenceOccurrenceId {
    if (!this.factMap.has(occurrence.factId)) {
      throw new MissingSemanticFactError(occurrence.factId)
    }
    const rebuilt = createEvidenceOccurrence({
      factId: occurrence.factId,
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
    if (rebuilt.id !== occurrence.id) {
      throw new InvalidEvidenceOccurrenceError(`id ${occurrence.id} does not match canonical payload ${rebuilt.id}`)
    }

    const existing = this.occurrenceMap.get(occurrence.id)
    const stored = existing === undefined
      ? rebuilt
      : createEvidenceOccurrence({
        factId: existing.factId,
        owner: canonicalChoice(existing.owner, rebuilt.owner),
        ...(existing.sourceFile !== undefined ? { sourceFile: existing.sourceFile } : {}),
        ...(existing.sourceRange !== undefined ? { sourceRange: existing.sourceRange } : {}),
        ...(existing.targetFile !== undefined ? { targetFile: existing.targetFile } : {}),
        ...(existing.targetRange !== undefined ? { targetRange: existing.targetRange } : {}),
        ...(existing.siteKind !== undefined ? { siteKind: existing.siteKind } : {}),
        ...(existing.adapterEvidenceKey !== undefined ? { adapterEvidenceKey: existing.adapterEvidenceKey } : {}),
        provenance: canonicalUnion(existing.provenance, rebuilt.provenance),
        confidenceObservations: canonicalUnion(existing.confidenceObservations, rebuilt.confidenceObservations),
        metadata: canonicalChoice(existing.metadata, rebuilt.metadata),
      })
    this.occurrenceMap.set(stored.id, stored)
    this.factOccurrenceIndex.get(stored.factId)?.add(stored.id)
    return stored.id
  }

  private addFactIndexEntry(index: Map<string, Set<SemanticFactId>>, key: string, factId: SemanticFactId): void {
    const entries = index.get(key)
    if (entries === undefined) {
      index.set(key, new Set([factId]))
    } else {
      entries.add(factId)
    }
  }

  private sortedFactIds(ids: ReadonlySet<SemanticFactId> | undefined): SemanticFactId[] {
    return [...(ids ?? [])].sort()
  }

  private sortedOccurrenceIds(ids: ReadonlySet<EvidenceOccurrenceId> | undefined): EvidenceOccurrenceId[] {
    return [...(ids ?? [])].sort()
  }

  private materializedFact(factId: SemanticFactId): SemanticFact {
    const stored = this.factMap.get(factId)
    if (stored === undefined) throw new MissingSemanticFactError(factId)
    return Object.freeze({
      ...stored.fact,
      occurrenceIds: Object.freeze(this.sortedOccurrenceIds(this.factOccurrenceIndex.get(factId))),
    })
  }

  isDirected(): boolean {
    return this.directed
  }

  hasNode(id: string): boolean {
    return this.nodeMap.has(id)
  }

  numberOfNodes(): number {
    return this.nodeMap.size
  }

  /** Returns the number of semantic relationships represented by the current store. */
  numberOfFacts(): number {
    return this.factMap.size
  }

  /** Returns the number of unique endpoint pairs represented by the current store. */
  numberOfEndpointPairs(): number {
    return this.endpointPairIndex.size
  }

  numberOfOccurrences(): number {
    return this.occurrenceMap.size
  }

  /** @deprecated Use numberOfFacts() or numberOfEndpointPairs() to state the intended semantics. */
  numberOfEdges(): number {
    return this.numberOfFacts()
  }

  /** Returns whether at least one relationship exists between the endpoints. */
  hasEdge(source: string, target: string): boolean {
    return this.endpointPairIndex.has(this.edgeKey(source, target))
  }

  nodeIds(): string[] {
    return [...this.nodeMap.keys()]
  }

  nodeEntries(): Array<[string, GraphAttributes]> {
    return [...this.nodeMap.entries()].map(([id, attributes]) => [id, { ...attributes }])
  }

  /**
   * Returns every semantic relationship in deterministic insertion order.
   * Relationship views and the returned collection cannot mutate graph state.
   */
  /**
   * Facts in a deterministic, meaningful order: source, then target, then
   * relation, with the fact id only as a final tie-break.
   *
   * Sorting by fact id alone is deterministic but arbitrary -- the id is a
   * content hash -- and that arbitrariness reaches users. It decided which of
   * three equally-weighted "high-risk shared boundary" candidates a pack
   * reported, so a pure hash reordering silently changed guidance output.
   */
  private orderedFactIds(): SemanticFactId[] {
    return [...this.factMap.keys()].sort((left, right) => {
      const a = this.factMap.get(left)!.fact
      const b = this.factMap.get(right)!.fact
      return a.source.localeCompare(b.source)
        || a.target.localeCompare(b.target)
        || String(a.relation).localeCompare(String(b.relation))
        || left.localeCompare(right)
    })
  }

  factEntries(): readonly GraphRelationshipEntry[] {
    return Object.freeze(this.orderedFactIds().map((factId) => {
      const stored = this.factMap.get(factId)!
      return Object.freeze([
        stored.fact.source,
        stored.fact.target,
        immutableGraphAttributes(stored.attributes),
      ] as const)
    }))
  }

  /** Returns semantic facts with their stable IDs and immutable compatibility attributes. */
  factRecords(): readonly GraphFactRecord[] {
    return Object.freeze(this.orderedFactIds().map((factId) => {
      const stored = this.factMap.get(factId)!
      return Object.freeze({
        fact: this.materializedFact(factId),
        attributes: immutableGraphAttributes(stored.attributes),
      })
    }))
  }

  fact(factId: SemanticFactId): SemanticFact {
    return this.materializedFact(factId)
  }

  factsFrom(source: string): readonly SemanticFact[] {
    return Object.freeze(this.sortedFactIds(this.sourceFactIndex.get(source)).map((id) => this.materializedFact(id)))
  }

  factsTo(target: string): readonly SemanticFact[] {
    return Object.freeze(this.sortedFactIds(this.targetFactIndex.get(target)).map((id) => this.materializedFact(id)))
  }

  factsByRelation(relation: string): readonly SemanticFact[] {
    return Object.freeze(this.sortedFactIds(this.relationFactIndex.get(relation)).map((id) => this.materializedFact(id)))
  }

  occurrenceEntries(): readonly EvidenceOccurrence[] {
    return Object.freeze([...this.occurrenceMap.keys()].sort().map((id) => this.occurrenceMap.get(id)!))
  }

  occurrencesForFact(factId: SemanticFactId): readonly EvidenceOccurrence[] {
    if (!this.factMap.has(factId)) throw new MissingSemanticFactError(factId)
    return Object.freeze(this.sortedOccurrenceIds(this.factOccurrenceIndex.get(factId)).map((id) => (
      this.occurrenceMap.get(id)!
    )))
  }

  /** Returns unique endpoint pairs in deterministic insertion order. */
  /**
   * Unique endpoint pairs in deterministic key order.
   *
   * Memoized because the ordering is what makes it expensive. Stage 2 added
   * the sort to guarantee determinism -- correct, but `cohesionScore` calls
   * this once per community, so on the self-graph that became 5,609 sorts of
   * 17,940 keys and 45% of total generation time. The sort is kept; it just
   * happens once per mutation instead of once per caller.
   */
  endpointEntries(): readonly GraphEndpointEntry[] {
    if (this.endpointEntriesCache !== null) return this.endpointEntriesCache
    const entries = Object.freeze([...this.endpointPairIndex.keys()].sort().map((key) => {
      const pair = this.endpointPairIndex.get(key)!
      return Object.freeze({ source: pair.source, target: pair.target })
    }))
    this.endpointEntriesCache = entries
    return entries
  }

  /** @deprecated Use factEntries() for relationships or endpointEntries() for topology. */
  edgeEntries(): Array<[string, string, GraphAttributes]> {
    return this.factEntries().map(([source, target, attributes]) => [source, target, { ...attributes }])
  }

  /** Returns unique outgoing neighbors in stable insertion order. */
  neighbors(id: string): string[] {
    return [...(this.successorMap.get(id) ?? [])]
  }

  /** Returns unique successors in stable insertion order. */
  successors(id: string): string[] {
    return this.neighbors(id)
  }

  /** Returns unique predecessors in stable insertion order. */
  predecessors(id: string): string[] {
    return [...(this.predecessorMap.get(id) ?? [])]
  }

  incidentNeighbors(id: string, limit = Number.POSITIVE_INFINITY): string[] {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : Number.POSITIVE_INFINITY
    if (boundedLimit === 0) {
      return []
    }

    const neighbors: string[] = []
    const seen = new Set<string>()
    const successors = (this.successorMap.get(id) ?? new Set()).values()
    const predecessors = (this.predecessorMap.get(id) ?? new Set()).values()
    let successorsDone = false
    let predecessorsDone = false

    const appendNext = (iterator: SetIterator<string>): boolean => {
      const next = iterator.next()
      if (next.done) {
        return true
      }
      if (!seen.has(next.value)) {
        seen.add(next.value)
        neighbors.push(next.value)
      }
      return false
    }

    // Alternate directions so a bounded incident scan cannot starve all
    // callers or all callees on a directed high-degree node.
    while (neighbors.length < boundedLimit && (!successorsDone || !predecessorsDone)) {
      if (!successorsDone) {
        successorsDone = appendNext(successors)
      }
      if (neighbors.length >= boundedLimit) {
        break
      }
      if (!predecessorsDone) {
        predecessorsDone = appendNext(predecessors)
      }
    }
    return neighbors
  }

  /** Returns the number of unique incident neighbors for a node. */
  uniqueNeighborDegree(id: string): number {
    return this.incidentNeighbors(id).length
  }

  /** @deprecated Use uniqueNeighborDegree() to state the intended topology semantics. */
  degree(id: string): number {
    return this.uniqueNeighborDegree(id)
  }

  nodeAttributes(id: string): GraphAttributes {
    const attributes = this.nodeMap.get(id)
    if (!attributes) {
      throw new Error(`Unknown node: ${id}`)
    }
    return { ...attributes }
  }

  nodeEndpointIdentity(id: string): EndpointIdentityEndpointQualification {
    if (!this.nodeMap.has(id)) {
      throw new Error(`Unknown node: ${id}`)
    }
    const qualification = this.nodeEndpointIdentityMap.get(id)
    try {
      return validateEndpointIdentityEndpointQualification(qualification)
    } catch (error) {
      if (error instanceof EndpointIdentityInvariantError) {
        throw new InvalidGraphEndpointQualificationError(id, error)
      }
      throw error
    }
  }

  /**
   * Detached, immutable projection of the storage-boundary admission counters.
   * Relation keys are lexically ordered and the total equals the sum of the
   * per-relation counts, so the summary is deterministic and self-checking.
   */
  storageAdmissionSummary(): StorageBoundaryAdmissionSummary {
    const counts = [...this.unregisteredRelationAdmissions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
    return Object.freeze({
      unresolvedUnregisteredRelationCandidates: counts.reduce((total, [, count]) => total + count, 0),
      unregisteredRelationCounts: Object.freeze(Object.fromEntries(counts)),
    })
  }

  copy(): KnowledgeGraph {
    return this.copySelectedNodes(new Set(this.nodeIds()))
  }

  subgraph(nodeIds: readonly string[]): KnowledgeGraph {
    return this.copySelectedNodes(new Set(nodeIds.filter((id) => this.hasNode(id))))
  }

  private copySelectedNodes(selectedNodeIds: ReadonlySet<string>): KnowledgeGraph {
    const copied = new KnowledgeGraph({ directed: this.directed })
    Object.assign(copied.graph, this.graph)
    // A copy must never look cleaner than its source; dropping these would let
    // any copy() launder away the degradation the summary exists to report.
    for (const [relation, count] of this.unregisteredRelationAdmissions) {
      copied.unregisteredRelationAdmissions.set(relation, count)
    }

    for (const [nodeId, attributes] of this.nodeMap) {
      if (!selectedNodeIds.has(nodeId)) continue
      copied.addNode(nodeId, {
        ...attributes,
        endpointIdentity: this.nodeEndpointIdentity(nodeId),
      })
    }

    for (const { fact, attributes } of this.factRecords()) {
      if (!selectedNodeIds.has(fact.source) || !selectedNodeIds.has(fact.target)) continue
      const admission = copied.addEdge(fact.source, fact.target, { ...attributes }, {
        discriminator: fact.discriminator,
        recordOccurrence: false,
      })
      if (admission.status !== 'stored' || admission.factId !== fact.id) {
        throw new GraphAdmissionError(`Copy changed semantic fact identity ${fact.id}`)
      }
      for (const occurrence of this.occurrencesForFact(fact.id)) {
        copied.addOccurrence(occurrence)
      }
    }

    return copied
  }

  /**
   * Returns every semantic relationship between two endpoints.
   * The current endpoint-keyed store projects zero or one item; callers must accept many.
   */
  factsBetween(
    source: string,
    target: string,
    options: FactsBetweenOptions = {},
  ): readonly GraphRelationshipView[] {
    const pair = this.endpointPairIndex.get(this.edgeKey(source, target))
    if (!pair) {
      return Object.freeze([])
    }

    const relations = options.relations ? new Set(options.relations) : null
    return Object.freeze(this.sortedFactIds(pair.factIds).flatMap((factId) => {
      const stored = this.factMap.get(factId)!
      return relations !== null && !relations.has(stored.fact.relation)
        ? []
        : [immutableGraphAttributes(stored.attributes)]
    }))
  }

  /** Returns unique relation values between two endpoints in stable fact order. */
  relationsBetween(source: string, target: string): readonly string[] {
    const pair = this.endpointPairIndex.get(this.edgeKey(source, target))
    if (pair === undefined) return Object.freeze([])
    const relations = new Set<string>()
    for (const factId of pair.factIds) {
      const stored = this.factMap.get(factId)
      if (stored !== undefined) relations.add(stored.fact.relation)
    }
    return Object.freeze([...relations].sort())
  }

  /** @deprecated Use factsBetween() and process every returned relationship explicitly. */
  edgeAttributes(source: string, target: string): GraphAttributes {
    const pair = this.endpointPairIndex.get(this.edgeKey(source, target))
    if (!pair) {
      throw new Error(`Unknown edge: ${source} ${this.directed ? '->' : '<->'} ${target}`)
    }
    const factIds = this.sortedFactIds(pair.factIds)
    if (factIds.length > 1) {
      throw new AmbiguousEdgeError(source, target, factIds)
    }
    return { ...this.factMap.get(factIds[0]!)!.attributes }
  }
}
