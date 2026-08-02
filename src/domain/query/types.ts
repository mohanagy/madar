import type { IndexBodyFact, IndexRange, IndexValue } from '../index/model.js'

export const RETRIEVE_RESULT_SCHEMA = 'madar.retrieve' as const,
  RETRIEVE_RESULT_VERSION = 2 as const,
  DEFAULT_RETRIEVE_BUDGET = 4000,
  MIN_RETRIEVE_BUDGET = 256,
  MAX_RETRIEVE_BUDGET = 4000,
  MAX_RETRIEVE_QUESTION_LENGTH = 512,
  MAX_RETRIEVE_FILES = 12,
  MAX_RETRIEVE_EXCERPTS = 25

export function valueHas(
  value: IndexValue, test: (candidate: IndexValue) => boolean,
): boolean {
  return test(value)
    || value.kind === 'array' && value.elements.some((entry) => valueHas(entry, test))
    || value.kind === 'object' && value.entries.some((entry) => valueHas(entry.value, test))
    || value.kind === 'template' && value.parts.some((entry) => valueHas(entry, test))
}

export interface NormalizedRetrieveRequest {
  question: string
  budget: number
}

export type RetrieveIntent = 'locate' | 'explain' | 'workflow'
type L<T> = readonly T[]
type M<T> = ReadonlyMap<string, T>
type FS = 'stale' | 'unavailable' | 'corrupt'
type EF = { state: FS; subject: string }
export type RetrieveObligationKind =
  | 'subject'
  | 'entry'
  | 'stage'
  | 'handoff'
  | 'behavior'
  | 'ordering'
  | 'terminal'
export type RetrieveState =
  | 'ready'
  | 'incomplete'
  | 'unsupported'
  | FS

type MK = `${'budget' | 'serialized'}_tokens` | 'selected_files'
  | 'authenticated_excerpts' | `${'required' | 'proven'}_obligations`
  | 'optional_bundles_omitted' | `${'root' | 'initial'}_candidates`
  | 'explored_nodes' | 'causal_hops' | 'recovery_frontier_nodes' | 'alternate_seeds'
export type RetrieveMetrics = Record<MK, number> & {
  recovery_passes: 0 | 1 | 2
}

export interface QuerySummary {
  intent: RetrieveIntent
  subject: string
  terms: L<string>
}
export type QueryIntent = RetrieveIntent
export type LocateAccess = 'read' | 'write'
export type ObligationKind = RetrieveObligationKind
export interface QueryObligation {
  id: `o${number}`; kind: ObligationKind; target: string; mandatory: boolean
}
export interface QueryPlan {
  intent: QueryIntent; subject: string; terms: L<string>
  obligations: L<QueryObligation>; access?: LocateAccess
}
export type QuestionPlanResult = {
  status: 'supported'; plan: QueryPlan
} | {
  status: 'unsupported'
  reason: 'unsupported_intent' | 'missing_subject'
  terms: L<string>
}

export type RetrieveMissingCode =
  | `${'subject' | 'entrypoint' | 'terminal_persistence' | 'corridor'
    | 'obligation_target' | 'adjacent_handoff' | 'behavior'
    | 'controller_dependency'}_unproven`
  | 'selection_bound_reached'
  | `required_${'file_limit' | 'excerpt_limit' | 'token_budget'
    | 'proof_missing' | 'reference_missing'}`

export interface MissingRequirement {
  code: RetrieveMissingCode
  obligation_id?: string
  target?: string
  required?: number
  limit?: number
}

type SF<K extends PropertyKey> = Record<K, string>
type Tag<K extends string> = { kind: K }
type DR<K extends PropertyKey = never> = SF<'id' | K>
type PR<K extends PropertyKey = never> = DR<K> & {
  proofs: L<string>
}
type OR = { operationIds: L<string> }
type WR = OR & { symbolIds: L<string> }

export type WorkflowRelation =
  | 'calls' | 'publishes_to' | 'routes_through' | 'consumed_by'
export type WorkflowMissingCode = Extract<
  RetrieveMissingCode, `${string}_unproven` | 'selection_bound_reached'
>
export type WorkflowEdge = SF<'id' | 'fromId' | 'toId'> & {
  relation: WorkflowRelation
}
export type WorkflowHandoff = OR & SF<'fromId' | 'toId'> & {
  kind: 'direct' | 'channel'; edgeIds: L<string>
}
export type WorkflowControlGroup = WR & {
  kind: 'branch' | 'loop' | 'parallel' | 'cycle' | 'sequence'
  controllerOperationId?: string; arm?: string
}
export type WorkflowObligationProof = WR & {
  id: `o${number}`; kind: RetrieveObligationKind; target: string
  mandatory: boolean; proven: boolean; edgeIds: L<string>
}
export type WorkflowMissingReason = {
  code: WorkflowMissingCode; obligationId?: string; target: string
}
export type WorkflowSelection = WR & {
  complete: boolean
  rootSymbolIds: L<string>
  terminalSymbolIds: L<string>
  edges: L<WorkflowEdge>
  links: L<WorkflowHandoff>
  controlGroups: L<WorkflowControlGroup>
  obligations: L<WorkflowObligationProof>
  missing: L<WorkflowMissingReason>
  metrics: {
    candidateCount: number; rootCandidateCount: number
    actualNodeCount: number; causalRelationHops: number
    recoveryPasses: 0 | 1 | 2; recoveryFrontierCount: number; bounded: boolean
  }
}

export type ProvenObligation = PR<'statement'> & {
  kind: RetrieveObligationKind
}

export type DossierFile = DR<'path' | 'digest'>

export type DossierExcerpt = DR<'file' | 'text'> & {
  range: readonly [number, number, number, number]
}

export type DossierControl = DR<'file'> & {
  ranges: L<readonly [number, number, number, number]>
}

export type DossierEntity = DR & (Tag<'symbol'> & SF<'label' | 'file'> & {
  node_kind?: string
  excerpt?: string
} | Tag<'channel'> & SF<'transport' | 'key'> & {
  channel_kind: 'queue' | 'job' | 'event'
  parent?: string
  scope?: string
} | Tag<'operation'> & { excerpt: string } & SF<'operation_kind' | 'owner'> & {
  detail: Readonly<Record<string, unknown>>
})

export type DossierProof = DR<'from' | 'to' | 'relation'> & (
  SF<'excerpt'> | { file: string; range: readonly [number, number, number, number] }
)

export type DossierLink = PR<'from' | 'to'> & {
  kind: 'direct' | 'channel'
}

export type DossierOrderGroup = DR & {
  kind: 'branch' | 'loop' | 'parallel' | 'cycle' | 'sequence'
  controller?: string
  arm?: string
  detail?: Readonly<Record<string, unknown>>
  depths?: L<number>
  members: L<string>
  proofs?: L<string>
}

export interface AnswerDossier {
  query: QuerySummary
  obligations: L<ProvenObligation>
  flow: {
    roots: L<string>
    terminals: L<string>
    links: L<DossierLink>
    order: L<DossierOrderGroup>
  }
  evidence: {
    digest_algorithm: 'sha256-base64url'
    files: L<DossierFile>
    excerpts: L<DossierExcerpt>
    controls: L<DossierControl>
    entities: L<DossierEntity>
    proofs: L<DossierProof>
  }
}

export type SelectedEvidenceEdge = DR<'fromId' | 'toId'> & {
  relation?: string
}

export interface EvidenceHydrationTargets {
  symbolIds: L<string>
  declarationSymbolIds: L<string>
  operationIds: L<string>
  validationOperationIds?: L<string>
  edges: L<SelectedEvidenceEdge>
}

export type HydratedFile = readonly [string, string]
export type HydratedExcerpt = readonly [string, string, IndexRange, string, string]
export type HydratedControl = readonly [string, IndexRange]
export type HydratedEntity =
  | readonly [string, 'symbol', string, string, string]
  | readonly [string, 'channel', 'queue' | 'job' | 'event', string, string,
    string | undefined, string | undefined]
  | readonly [string, 'operation', string, IndexBodyFact]
export type HydratedProof =
  | readonly [string, 'declaration' | 'operation', string, string]
  | readonly [string, 'edge', string, string, string, string]
  | readonly [string, 'edge_range', string, string, string, string, IndexRange]
export type HydratedEvidenceResult = {
  state: 'ready'
  files: M<HydratedFile>
  controls: M<HydratedControl>
  entities: M<HydratedEntity>
  excerpts: M<HydratedExcerpt>
  proofs: M<HydratedProof>
} | EF

interface RB<S extends RetrieveState> {
  schema: typeof RETRIEVE_RESULT_SCHEMA
  version: typeof RETRIEVE_RESULT_VERSION
  state: S
  metrics: RetrieveMetrics
}

export type RetrieveContextResult =
  | RB<'ready'> & { dossier: AnswerDossier }
  | RB<'incomplete'> & {
    query: QuerySummary
    missing: L<MissingRequirement>
  }
  | RB<'unsupported'> & {
    reason: 'unsupported_intent' | 'missing_subject' | 'unsupported_source'
    terms: L<string>
  }
  | RB<FS> & {
    failures: L<EF>
  }

export function normalizeRetrieveRequest(value: unknown): NormalizedRetrieveRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('retrieve input must be an object')
  }
  const request = value as Record<string, unknown>
  if (Object.keys(request).some((key) => key !== 'budget' && key !== 'question')) {
    throw new TypeError('retrieve accepts only question and optional budget')
  }
  const question = typeof request.question === 'string' ? request.question.trim() : ''
  if (question.length === 0 || question.length > MAX_RETRIEVE_QUESTION_LENGTH) {
    throw new TypeError(
      `retrieve question must be between 1 and ${MAX_RETRIEVE_QUESTION_LENGTH} characters`,
    )
  }
  const budget = request.budget
  if (budget !== undefined && (typeof budget !== 'number'
    || !Number.isSafeInteger(budget) || budget <= 0)) {
    throw new TypeError('retrieve budget must be a positive integer')
  }
  return {
    question,
    budget: Math.max(
      MIN_RETRIEVE_BUDGET,
      Math.min(budget ?? DEFAULT_RETRIEVE_BUDGET, MAX_RETRIEVE_BUDGET),
    ),
  }
}
