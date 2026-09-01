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

export interface LoadedAdjudication {
  readonly contract: Record<string, unknown> | null
  readonly digest: string | null
  /** Non-empty means the run must not be measured. */
  readonly problems: readonly string[]
  /** Keyed by `<file>#<json-pointer>`; exactly one entry per frozen clause. */
  readonly byClause: ReadonlyMap<string, AdjudicationEntry>
  readonly requirementsById: ReadonlyMap<string, RequirementIdentity>
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
