/** Where the frozen machine-checkable adjudication contract lives. */
export declare const ADJUDICATION_PATH: 'docs/qualification/tier1-adjudication.json'

/** The exact failure recorded when the contract does not match its sources. */
export declare const CONTRACT_MISMATCH: 'adjudication_contract_mismatch'

/**
 * The closed predicate union. A kind outside this set refuses the run, so no
 * natural-language predicate can be introduced by editing the contract alone.
 */
export declare const PREDICATE_KINDS: ReadonlySet<string>

export interface AdjudicationEntry {
  readonly id: string
  readonly source: { file: string; pointer: string; clause_sha256: string }
  readonly predicate: { kind: string; params: Record<string, unknown> }
  readonly rationale?: string
  readonly truth_provenance?: Record<string, unknown>
}

export interface RequirementIdentity {
  readonly id: string
  /** Present on a contract-loaded identity; a caller may supply a bare one. */
  readonly source?: { file: string; pointer: string }
  readonly identity_sha256?: string
  readonly path?: string
  readonly symbols?: readonly string[]
}

/** Topologies, directions, cardinalities and policies the model supports. */
export declare const RELATIONSHIP_TOPOLOGIES: ReadonlySet<string>
export declare const RELATIONSHIP_DIRECTIONS: ReadonlySet<string>
export declare const RELATIONSHIP_GROUP_MATCH: ReadonlySet<string>
export declare const UNRESOLVED_POLICIES: ReadonlySet<string>

export interface EndpointSelector {
  readonly path: string
  readonly symbols: readonly string[]
  readonly frozen_source?: { file: string; pointer: string; identity_sha256: string }
}

export interface RelationshipRequirement {
  readonly id: string
  readonly source_selector: EndpointSelector
  readonly target_selector: EndpointSelector
  readonly direction: 'forward'
  readonly topology: 'direct_edge'
  readonly relation_kinds: readonly string[]
  readonly required_edge_count: number
  /** Equals `id`, or null when the frozen clause offers no unresolved escape. */
  readonly unresolved_subject_id: string | null
}

/** How one relationship-bearing channel is read. */
export interface RelationshipAdapter {
  readonly channel: string
  readonly source_field: string
  readonly target_field: string
  readonly relation_field: string
  readonly source_id_field: string | null
  readonly target_id_field: string | null
  readonly semantic_direction: 'source_to_target'
  readonly endpoint_resolution: 'node_id' | 'unique_label_in_scope'
  readonly node_record_channels: readonly string[]
}

export interface TypedEdge {
  readonly channel: string
  readonly relation: string
  readonly source_label: string
  readonly target_label: string
  readonly source: { label: string; source_file: string; node_id: string | null } | null
  readonly target: { label: string; source_file: string; node_id: string | null } | null
}

export interface RelationshipOutcome {
  readonly id: string
  readonly present: boolean
  readonly matches: readonly Record<string, unknown>[]
  /** Edges touching both endpoints but rejected for direction or relation kind. */
  readonly rejected: readonly Record<string, unknown>[]
  readonly required_edge_count: number
  readonly direction: string
  readonly relation_kinds: readonly string[]
}

/** Typed relationships the artifact presents, through the declared adapters. */
export declare function extractTypedEdges(
  artifact: Record<string, unknown>,
  adapters: readonly RelationshipAdapter[],
): TypedEdge[]

/** Is one frozen relationship satisfied? Direction and relation kind enforced. */
export declare function evaluateRelationship(
  requirement: RelationshipRequirement,
  edges: readonly TypedEdge[],
  normaliseSymbol: (symbol: string) => string,
): RelationshipOutcome

export interface LoadedAdjudication {
  readonly contract: Record<string, unknown> | null
  readonly digest: string | null
  /** Non-empty means the run must not be measured. */
  readonly problems: readonly string[]
  /** Keyed by `<file>#<json-pointer>`; exactly one entry per frozen clause. */
  readonly byClause: ReadonlyMap<string, AdjudicationEntry>
  readonly requirementsById: ReadonlyMap<string, RequirementIdentity>
  readonly relationshipsById: ReadonlyMap<string, RelationshipRequirement>
  readonly adapters: readonly RelationshipAdapter[]
}

export declare function loadAdjudication(
  root: string,
  options?: { requiredClauses?: readonly { file: string; pointer: string }[] },
): LoadedAdjudication

/** RFC 6901 pointer resolution; undefined when the pointer does not resolve. */
export declare function resolvePointer(doc: unknown, pointer: string): unknown

/**
 * Find a typed record or token declaring `subjectId`. Only a channel whose
 * SCHEMA carries the status and the subject can match; free text never can.
 */
export declare function findTypedDeclaration(
  artifact: Record<string, unknown>,
  channels: readonly Record<string, unknown>[],
  subjectId: string | null,
): Record<string, unknown> | null

/** Is one frozen requirement identity surfaced by the evidence set? */
export declare function requirementPresent(
  requirement: RequirementIdentity,
  evidence: { generous: { paths: readonly string[]; symbols: readonly string[] } },
  normaliseSymbol: (symbol: string) => string,
): { present: boolean; path_present: boolean; symbol_present: boolean }
