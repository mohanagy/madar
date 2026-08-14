import type { CanonicalJson } from './canonical-json.js'
import type { EndpointIdentityQualification } from './endpoint-identity.js'
import type { SemanticDiscriminator } from './relation-discriminator.js'

export type NodeId = string
export type SemanticFactId = `sf_${string}`
export type EvidenceOccurrenceId = `eo_${string}`
export type SemanticFactDirection = 'directed' | 'undirected'

export interface SourcePosition {
  readonly line: number
  readonly column: number
}

export interface SourceRange {
  readonly start: SourcePosition
  readonly end: SourcePosition
}

export interface SemanticFact {
  readonly id: SemanticFactId
  readonly direction: SemanticFactDirection
  readonly source: NodeId
  readonly target: NodeId
  /** Native facts use a registered relation; v1 compatibility facts may retain a historical relation string. */
  readonly relation: string
  readonly discriminator: SemanticDiscriminator
  readonly endpointIdentity: EndpointIdentityQualification
  readonly occurrenceIds: readonly EvidenceOccurrenceId[]
  readonly annotations: Readonly<Record<string, CanonicalJson>>
}

export interface EvidenceOccurrenceOwner {
  readonly adapterId: string
  readonly strategy: string
  readonly sourceFile?: string
  readonly adapterVersion?: string
}

export interface EvidenceProvenance {
  readonly capability_id: string
  readonly stage?: string
  readonly [key: string]: unknown
}

export interface ConfidenceObservation {
  readonly confidence: string
  readonly score?: number
  readonly observedAt?: string
  readonly [key: string]: unknown
}

export interface EvidenceOccurrence {
  readonly id: EvidenceOccurrenceId
  readonly factId: SemanticFactId
  readonly owner: EvidenceOccurrenceOwner
  readonly sourceFile?: string
  readonly sourceRange?: SourceRange
  readonly targetFile?: string
  readonly targetRange?: SourceRange
  readonly siteKind?: string
  readonly adapterEvidenceKey?: string
  readonly provenance: readonly EvidenceProvenance[]
  readonly confidenceObservations: readonly ConfidenceObservation[]
  readonly metadata: Readonly<Record<string, CanonicalJson>>
}
