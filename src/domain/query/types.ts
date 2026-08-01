import type { IndexBodyFact, IndexRange, IndexValue } from '../index/model.js'

export const RETRIEVE_RESULT_SCHEMA = 'madar.retrieve' as const
export const RETRIEVE_RESULT_VERSION = 2 as const
export const DEFAULT_RETRIEVE_BUDGET = 4000
export const MIN_RETRIEVE_BUDGET = 256
export const MAX_RETRIEVE_BUDGET = 4000
export const MAX_RETRIEVE_QUESTION_LENGTH = 512
export const MAX_RETRIEVE_FILES = 12
export const MAX_RETRIEVE_EXCERPTS = 25

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
type List<T> = readonly T[]
type FailureState = 'stale' | 'unavailable' | 'corrupt'
type EvidenceFailure = { state: FailureState; subject: string }
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
  | FailureState

type MetricKey = `${'budget' | 'serialized'}_tokens` | 'selected_files'
  | 'authenticated_excerpts' | `${'required' | 'proven'}_obligations`
  | 'optional_bundles_omitted' | `${'root' | 'initial'}_candidates`
  | 'explored_nodes' | 'causal_hops' | 'recovery_frontier_nodes' | 'alternate_seeds'
export type RetrieveMetrics = Record<MetricKey, number> & {
  recovery_passes: 0 | 1 | 2
}

export interface QuerySummary {
  intent: RetrieveIntent
  subject: string
  terms: List<string>
}
export type QueryIntent = RetrieveIntent
export type LocateAccess = 'read' | 'write'
export type ObligationKind = RetrieveObligationKind
export interface QueryObligation {
  id: `o${number}`; kind: ObligationKind; target: string; mandatory: boolean
}
export interface QueryPlan {
  intent: QueryIntent; subject: string; terms: List<string>
  obligations: List<QueryObligation>; access?: LocateAccess
}
export type QuestionPlanResult = {
  status: 'supported'; plan: QueryPlan
} | {
  status: 'unsupported'
  reason: 'unsupported_intent' | 'missing_subject'
  terms: List<string>
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

type StringFields<K extends PropertyKey> = Record<K, string>
type Tagged<K extends string> = { kind: K }
type DossierRow<K extends PropertyKey = never> = StringFields<'id' | K>
type ProvenRow<K extends PropertyKey = never> = DossierRow<K> & {
  proofs: List<string>
}
type OperationRefs = { operationIds: List<string> }
type WorkflowRefs = OperationRefs & { symbolIds: List<string> }

export type WorkflowRelation =
  | 'calls' | 'publishes_to' | 'routes_through' | 'consumed_by'
export type WorkflowMissingCode = Extract<
  RetrieveMissingCode, `${string}_unproven` | 'selection_bound_reached'
>
export type WorkflowEdge = StringFields<'id' | 'fromId' | 'toId'> & {
  relation: WorkflowRelation
}
export type WorkflowHandoff = OperationRefs & StringFields<'fromId' | 'toId'> & {
  kind: 'direct' | 'channel'; edgeIds: List<string>
}
export type WorkflowControlGroup = WorkflowRefs & {
  kind: 'branch' | 'loop' | 'parallel' | 'cycle' | 'sequence'
  controllerOperationId?: string; arm?: string
}
export type WorkflowObligationProof = WorkflowRefs & {
  id: `o${number}`; kind: RetrieveObligationKind; target: string
  mandatory: boolean; proven: boolean; edgeIds: List<string>
}
export type WorkflowMissingReason = {
  code: WorkflowMissingCode; obligationId?: string; target: string
}
export type WorkflowSelection = WorkflowRefs & {
  complete: boolean
  rootSymbolIds: List<string>
  terminalSymbolIds: List<string>
  edges: List<WorkflowEdge>
  links: List<WorkflowHandoff>
  controlGroups: List<WorkflowControlGroup>
  obligations: List<WorkflowObligationProof>
  missing: List<WorkflowMissingReason>
  metrics: {
    candidateCount: number; rootCandidateCount: number
    actualNodeCount: number; causalRelationHops: number
    recoveryPasses: 0 | 1 | 2; recoveryFrontierCount: number; bounded: boolean
  }
}

export type ProvenObligation = ProvenRow<'statement'> & {
  kind: RetrieveObligationKind
}

export type DossierFile = DossierRow<'path' | 'digest'>

export type DossierExcerpt = DossierRow<'file' | 'text'> & {
  range: readonly [number, number, number, number]
}

export type DossierEntity = DossierRow & (Tagged<'symbol'> & StringFields<'label' | 'file'> & {
  node_kind?: string
  excerpt?: string
} | Tagged<'channel'> & StringFields<'transport' | 'key'> & {
  channel_kind: 'queue' | 'job' | 'event'
  parent?: string
  scope?: string
} | Tagged<'operation'> & { excerpt: string } & (StringFields<'operation_kind' | 'owner'> & {
  detail: Readonly<Record<string, unknown>>
  links?: never
} | {
  links: List<string>; order: List<number>
  callee?: string
  scheduling?: string
}))

export type DossierProof = DossierRow<'excerpt' | 'from' | 'to' | 'relation'>

export type DossierLink = ProvenRow<'from' | 'to'> & {
  kind: 'direct' | 'channel'
}

export type DossierOrderGroup = ProvenRow & {
  kind: 'branch' | 'loop' | 'parallel' | 'cycle' | 'sequence'
  controller?: string
  arm?: string
  depth?: number
  detail?: Readonly<Record<string, unknown>>
  members: List<string>
}

export interface AnswerDossier {
  query: QuerySummary
  obligations: List<ProvenObligation>
  flow: {
    roots: List<string>
    terminals: List<string>
    links: List<DossierLink>
    order: List<DossierOrderGroup>
  }
  evidence: {
    digest_algorithm: 'sha256-base64url'
    files: List<DossierFile>
    excerpts: List<DossierExcerpt>
    entities: List<DossierEntity>
    proofs: List<DossierProof>
  }
}

export type SelectedEvidenceEdge = DossierRow<'fromId' | 'toId'> & {
  relation?: string
}

export interface EvidenceHydrationTargets {
  symbolIds: List<string>
  declarationSymbolIds: List<string>
  operationIds: List<string>
  validationOperationIds?: List<string>
  edges: List<SelectedEvidenceEdge>
}

export type HydratedFile = readonly [alias: string, sha256: string]
export type HydratedExcerpt = readonly [
  alias: string, file: string, range: IndexRange, sha256: string, text: string,
]
export type HydratedEntity =
  | readonly [
    alias: string, kind: 'symbol', label: string, nodeKind: string, file: string,
  ]
  | readonly [
    alias: string, kind: 'channel', channelKind: 'queue' | 'job' | 'event',
    transport: string, key: string,
    parentChannelId: string | undefined, scope: string | undefined,
  ]
  | readonly [
    alias: string, kind: 'operation', owner: string, fact: IndexBodyFact,
  ]
export type HydratedProof =
  | readonly [
    alias: string, kind: 'declaration' | 'operation',
    subject: string, excerpt: string,
  ]
  | readonly [
    alias: string, kind: 'edge', from: string, to: string,
    relation: string, excerpt: string,
  ]
export type HydratedEvidenceResult = {
  state: 'ready'
  files: ReadonlyMap<string, HydratedFile>
  entities: ReadonlyMap<string, HydratedEntity>
  excerpts: ReadonlyMap<string, HydratedExcerpt>
  proofs: ReadonlyMap<string, HydratedProof>
} | EvidenceFailure

interface RetrieveResultBase<S extends RetrieveState> {
  schema: typeof RETRIEVE_RESULT_SCHEMA
  version: typeof RETRIEVE_RESULT_VERSION
  state: S
  metrics: RetrieveMetrics
}

export type RetrieveContextResult =
  | RetrieveResultBase<'ready'> & { dossier: AnswerDossier }
  | RetrieveResultBase<'incomplete'> & {
    query: QuerySummary
    missing: List<MissingRequirement>
  }
  | RetrieveResultBase<'unsupported'> & {
    reason: 'unsupported_intent' | 'missing_subject'
    terms: List<string>
  }
  | RetrieveResultBase<FailureState> & {
    failures: List<EvidenceFailure>
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
