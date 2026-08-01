import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'

import {
  hydrateEvidence,
} from './evidence-hydrator.js'
import { canonicalJsonString, compareCodeUnits as compare } from '../domain/graph/canonical-json.js'
import type { IndexBodyFact, IndexValue } from '../domain/index/model.js'
import type { QueryIndex, ReadyQueryIndex } from '../domain/query/index-status.js'
import { planQuestion } from '../domain/query/plan.js'
import {
  selectWorkflow,
} from '../domain/query/workflow.js'
import {
  MAX_RETRIEVE_EXCERPTS,
  MAX_RETRIEVE_FILES,
  RETRIEVE_RESULT_SCHEMA,
  RETRIEVE_RESULT_VERSION,
  normalizeRetrieveRequest,
  valueHas,
  type AnswerDossier,
  type DossierEntity,
  type DossierLink,
  type DossierOrderGroup,
  type DossierProof,
  type HydratedEvidenceResult,
  type MissingRequirement,
  type NormalizedRetrieveRequest,
  type QuerySummary,
  type QueryPlan,
  type RetrieveContextResult,
  type RetrieveMetrics,
  type WorkflowSelection,
} from '../domain/query/types.js'

type ReadyHydration = Extract<HydratedEvidenceResult, { state: 'ready' }>
type InternalHydration = HydratedEvidenceResult
type DossierBuild = { state: 'ready'; dossier: AnswerDossier }
  | { state: 'incomplete'; missing: MissingRequirement }
  | { state: 'corrupt'; subject: string }

function missingBuild(
  code: 'required_proof_missing' | 'required_reference_missing',
  target: string,
  obligationId?: string,
): DossierBuild {
  return { state: 'incomplete', missing: {
    code, target, ...(obligationId ? { obligation_id: obligationId } : {}),
  } }
}

function limitMissing(
  code: 'required_file_limit' | 'required_excerpt_limit' | 'required_token_budget',
  required: number,
  limit: number,
): readonly MissingRequirement[] {
  return [{ code, required, limit }]
}

const VALID_LINKS = new Set([
  'direct:calls',
  'channel:publishes_to,consumed_by',
  'channel:publishes_to,routes_through,consumed_by',
])

function metrics(
  request: NormalizedRetrieveRequest,
  selection?: WorkflowSelection,
  hydration?: ReadyHydration,
  failed = new Set<string>(),
): RetrieveMetrics {
  const required = selection?.obligations.filter(({ mandatory }) => mandatory) ?? []
  const source = selection?.metrics
  return {
    budget_tokens: request.budget,
    serialized_tokens: 0,
    selected_files: hydration?.files.size ?? 0,
    authenticated_excerpts: hydration?.excerpts.size ?? 0,
    required_obligations: required.length,
    proven_obligations: required.filter(({ proven, id }) => proven && !failed.has(id)).length,
    optional_bundles_omitted: 0,
    root_candidates: source?.rootCandidateCount ?? 0,
    initial_candidates: source?.candidateCount ?? 0,
    explored_nodes: source?.actualNodeCount ?? 0,
    causal_hops: source?.causalRelationHops ?? 0,
    recovery_passes: source?.recoveryPasses ?? 0,
    recovery_frontier_nodes: source?.recoveryFrontierCount ?? 0,
    alternate_seeds: Math.max(0, (source?.rootCandidateCount ?? 0) - 1),
  }
}

function stabilize<T extends RetrieveContextResult>(input: T): T {
  input.metrics.serialized_tokens = 0
  const body = countTokens(canonicalJsonString(input)) - countTokens('0')
  const estimate = body + countTokens(String(body))
  input.metrics.serialized_tokens = body + countTokens(String(estimate))
  return input
}

function header<S extends RetrieveContextResult['state']>(
  state: S,
  request: NormalizedRetrieveRequest,
  selection?: WorkflowSelection,
  hydration?: ReadyHydration,
  failed?: Set<string>,
): { schema: typeof RETRIEVE_RESULT_SCHEMA; version: typeof RETRIEVE_RESULT_VERSION
    state: S; metrics: RetrieveMetrics } {
  return { schema: RETRIEVE_RESULT_SCHEMA, version: RETRIEVE_RESULT_VERSION,
    state, metrics: metrics(request, selection, hydration, failed) }
}

function query(plan: QueryPlan): QuerySummary {
  return { intent: plan.intent, subject: plan.subject, terms: plan.terms }
}

type TerminalResult = Exclude<RetrieveContextResult, { state: 'ready' }>
function fitTerminal(input: TerminalResult, budget: number): TerminalResult {
  const result = stabilize(input)
  if (result.metrics.serialized_tokens <= budget) return result
  if (result.state === 'incomplete') {
    result.query.subject = result.query.subject.slice(0, 32)
    result.query.terms = []
    result.missing = result.missing.map(({
      code, obligation_id, required, limit,
    }) => ({
      code,
      ...(obligation_id ? { obligation_id } : {}),
      ...(required === undefined ? {} : { required }),
      ...(limit === undefined ? {} : { limit }),
    }))
  } else if (result.state === 'unsupported') result.terms = []
  else result.failures = result.failures.map(({ state, subject }) =>
    ({ state, subject: subject.slice(0, 32) }))
  stabilize(result)
  if (result.metrics.serialized_tokens > budget && result.state === 'incomplete') {
    result.query.subject = ''
    stabilize(result)
  }
  if (result.metrics.serialized_tokens > budget) return stabilize({
    schema: result.schema, version: result.version, state: 'corrupt',
    metrics: result.metrics,
    failures: [{ state: 'corrupt', subject: 'terminal result budget' }],
  })
  return result
}

function declarationTargets(
  plan: QueryPlan, selection: WorkflowSelection, index: ReadyQueryIndex,
): string[] {
  const required = plan.intent === 'locate' ? selection.symbolIds.slice(0, 1) : []
  const subject = selection.obligations.find(({ kind, proven }) =>
    kind === 'subject' && proven)
  if (plan.intent === 'explain' && subject) required.push(...subject.symbolIds.slice(0, 1))
  const incident = new Set(selection.edges.flatMap(({ fromId, toId }) => [fromId, toId]))
  for (const id of selection.operationIds) {
    const owner = index.operation_by_id.get(id)?.owner_symbol_id
    if (owner) incident.add(owner)
  }
  required.push(...selection.symbolIds.filter((id) => !incident.has(id)))
  return [...new Set(required)].sort(compare)
}

function emittedOperations(
  plan: QueryPlan, selection: WorkflowSelection, index: ReadyQueryIndex,
): string[] {
  const path = new Set([
    ...selection.rootSymbolIds, ...selection.terminalSymbolIds,
    ...selection.links.flatMap(({ fromId, toId }) => [fromId, toId]),
  ])
  const result = new Set(selection.operationIds.filter((id) => {
    const fact = index.operation_by_id.get(id)
    return fact && (plan.intent !== 'workflow'
      || !['condition', 'loop', 'parallel'].includes(fact.kind))
      && (fact.kind !== 'call' || path.has(fact.owner_symbol_id))
  }))
  for (const id of result) {
    const fact = index.operation_by_id.get(id)
    if (fact?.kind === 'persistence') result.add(fact.call_fact_id)
    if (fact?.kind === 'parallel') fact.member_fact_ids.forEach((member) => result.add(member))
  }
  return [...result].sort(compare)
}

function incomplete(
  request: NormalizedRetrieveRequest,
  plan: QueryPlan,
  missing: readonly MissingRequirement[],
  selection?: WorkflowSelection,
  hydration?: ReadyHydration,
  packedFailure = false,
): RetrieveContextResult {
  const failed = new Set(missing.flatMap((entry) =>
    entry.obligation_id ? [entry.obligation_id] : []))
  if (packedFailure && failed.size === 0) {
    for (const entry of selection?.obligations ?? []) if (entry.mandatory) failed.add(entry.id)
  }
  return fitTerminal({
    ...header('incomplete', request, selection, hydration, failed),
    query: query(plan),
    missing,
  }, request.budget)
}

function failure(
  request: NormalizedRetrieveRequest,
  state: 'stale' | 'unavailable' | 'corrupt',
  subject: string,
  selection?: WorkflowSelection,
): RetrieveContextResult {
  return fitTerminal({
    ...header(state, request, selection),
    failures: [{ state, subject: subject.slice(0, 96) }],
  }, request.budget)
}

function projectValue(value: IndexValue, entity: (id: string) => string | undefined): object {
  if (value.kind === 'symbol') {
    const id = entity(value.symbol_id)
    return id ? { kind: 'symbol', entity: id } : { kind: 'unknown', reason: 'outside_dossier' }
  }
  if (value.kind === 'array' || value.kind === 'template') {
    const entries = value.kind === 'array' ? value.elements : value.parts
    return {
      kind: value.kind,
      [value.kind === 'array' ? 'elements' : 'parts']:
        entries.map((entry) => projectValue(entry, entity)),
    }
  }
  if (value.kind === 'object') {
    return { kind: 'object', entries: value.entries.map(({ key, value: entry }) => ({
      key,
      value: projectValue(entry, entity),
    })) }
  }
  return value
}

type ReferenceKey = 'rootSymbolIds' | 'terminalSymbolIds' | 'symbolIds'
  | 'operationIds' | 'edgeIds' | 'controllerOperationId' | 'fromId' | 'toId'
const DETAIL_FIELDS = {
  literal: ['role'], condition: ['condition_kind'], loop: ['loop_kind'],
  parallel: ['combinator', 'completion', 'lane_count'],
  return: [], throw: [], mutation: ['operation', 'target'],
  persistence: ['operation', 'receiver_type'],
} as const

function operationDetail(
  fact: IndexBodyFact,
  entity: (id: string) => string | undefined,
): Readonly<Record<string, unknown>> {
  const value = (entry: IndexValue | undefined): unknown =>
    entry === undefined ? undefined : projectValue(entry, entity)
  if (fact.kind === 'call') {
    const target = fact.target_symbol_id ? entity(fact.target_symbol_id) : undefined
    const arguments_ = fact.arguments.some((entry) => valueHas(
      entry, (candidate) => candidate.kind === 'literal',
    )) ? fact.arguments.map((entry) => projectValue(entry, entity)) : undefined
    return { order: fact.order, callee: fact.callee, scheduling: fact.scheduling,
      ...(target ? { target } : {}), ...(arguments_ ? { arguments: arguments_ } : {}) }
  }
  const result: Record<string, unknown> = { order: fact.order }
  const raw = fact as unknown as Record<string, unknown>
  for (const key of DETAIL_FIELDS[fact.kind]) result[key] = raw[key]
  if (fact.kind === 'parallel') {
    result.members = fact.member_fact_ids.map((id) => entity(id)!)
    if (fact.input !== undefined) result.input = value(fact.input)
  } else if (fact.kind === 'persistence') {
    result.call = entity(fact.call_fact_id)!
    if (fact.resource !== undefined) result.resource = value(fact.resource)
  } else if (['literal', 'return', 'throw', 'mutation'].includes(fact.kind)) {
    const item = raw.value as IndexValue | undefined
    if (item !== undefined) result.value = value(item)
  }
  else {
    const test = value(raw.test as IndexValue | undefined)
    if (fact.kind === 'loop' || test && (typeof test !== 'object'
      || !('kind' in test) || test.kind !== 'unknown')) result.test = test
  }
  return result
}

function statement(
  obligation: WorkflowSelection['obligations'][number],
  plan: QueryPlan,
): string {
  const kind = obligation.kind
  return kind === 'subject' ? `${plan.subject}.`
    : kind === 'handoff' ? 'Handoffs proven.'
      : kind === 'behavior' ? 'Operations proven.'
        : kind === 'ordering' ? 'Order proven.' : `${kind} proven.`
}

function buildDossier(
  plan: QueryPlan,
  selection: WorkflowSelection,
  hydration: ReadyHydration,
  emittedOperationIds: readonly string[],
  index: ReadyQueryIndex,
): DossierBuild {
  const {
    symbolIds, operationIds: allOperationIds, rootSymbolIds: rootIds,
    terminalSymbolIds: terminalIds, edges: selectedEdges,
    links: selectedLinks, controlGroups: groups,
    obligations: selectedObligations,
  } = selection
  const lookup = (canonical: string): string | undefined =>
    hydration.entities.get(canonical)?.[0]
  const entity = (canonical: string): string => lookup(canonical)!
  const edge = (id: string) => {
    const proof = hydration.proofs.get(id)
    return proof?.[1] === 'edge' ? proof : undefined
  }
  const proofs: DossierProof[] = []
  for (const proof of hydration.proofs.values()) if (proof[1] === 'edge') {
    proofs.push({
      id: proof[0], from: proof[2], to: proof[3],
      relation: proof[4], excerpt: proof[5],
    })
  }
  for (const [canonical, item] of hydration.entities) {
    if (item[1] === 'channel' && item[5] && !hydration.entities.has(item[5])) {
      return missingBuild('required_reference_missing', item[5])
    }
    if (item[1] === 'operation' && hydration.proofs.get(canonical)?.[1] !== 'operation') {
      return missingBuild('required_proof_missing', canonical)
    }
  }
  const missingEntity = [...symbolIds, ...emittedOperationIds]
    .find((id) => !hydration.entities.has(id))
  const missing = missingEntity
    ?? selectedEdges.find((item) => !edge(item.id))?.id
  if (missing) return missingBuild(
    missingEntity ? 'required_reference_missing' : 'required_proof_missing', missing,
  )
  const selected: Record<ReferenceKey, readonly string[]> = {
    rootSymbolIds: symbolIds, terminalSymbolIds: symbolIds,
    symbolIds, fromId: symbolIds, toId: symbolIds,
    operationIds: allOperationIds, controllerOperationId: allOperationIds,
    edgeIds: selectedEdges.map((edge) => edge.id),
  }
  let forged = [...rootIds, ...terminalIds].find((id) => !symbolIds.includes(id))
  for (const row of [
    ...selectedLinks, ...groups, ...selectedObligations,
  ]) for (const [key, value] of Object.entries(row)) {
    const allowed = selected[key as ReferenceKey]
    if (allowed) forged ??= [value].flat()
      .find((id) => !allowed.includes(id as string)) as string | undefined
  }
  if (forged) return { state: 'corrupt', subject: forged }
  const links: DossierLink[] = []
  for (const [index, link] of selectedLinks.entries()) {
    const chain = link.edgeIds.map((id) => edge(id)!)
    const from = entity(link.fromId), to = entity(link.toId)
    const joined = chain.every((proof, proofIndex) =>
      proof[2] === (proofIndex === 0 ? from : chain[proofIndex - 1]![3]))
      && chain.at(-1)![3] === to
    if (!VALID_LINKS.has(
      `${link.kind}:${chain.map((proof) => proof[4]).join(',')}`,
    ) || !joined) {
      return { state: 'corrupt', subject: `${link.fromId}->${link.toId}` }
    }
    const id = `l${index + 1}`
    links.push({
      id, kind: link.kind, from, to,
      proofs: [...new Set(chain.map((proof) => proof[0]))],
    })
  }
  const entities: DossierEntity[] = []
  const ownerProof = new Map<string, string>()
  const persisted = new Set<string>()
  for (const [canonical, item] of hydration.entities) {
    const alias = item[0]
    const proof = hydration.proofs.get(canonical)
    const excerpt = proof?.[1] !== 'edge' ? proof?.[3] : undefined
    if (item[1] === 'symbol') {
      entities.push({
        id: alias, kind: 'symbol', label: item[2],
        ...(/^(?:function|method|class)$/u.test(item[3])
          ? {} : { node_kind: item[3] }),
        file: item[4],
        ...(excerpt ? { excerpt } : {}),
      })
    } else if (item[1] === 'channel') {
      const parent = item[5] ? entity(item[5]) : undefined
      entities.push({
        id: alias, kind: 'channel', channel_kind: item[2],
        transport: item[3], key: item[4],
        ...(parent ? { parent } : {}),
        ...(item[6] ? { scope: item[6] } : {}),
      })
    } else {
      const fact = item[3]
      const linked = selectedLinks.flatMap((link, index) =>
        link.operationIds.includes(canonical) ? [index] : [])
      if (fact.kind === 'call' && linked.length > 0) {
        if (linked.some((index) => selectedLinks[index]!.fromId !== fact.owner_symbol_id)) {
          return { state: 'corrupt', subject: canonical }
        }
        entities.push({
          id: alias, kind: 'operation', links: linked.map((index) => `l${index + 1}`),
          order: fact.order, excerpt: excerpt!,
          ...(linked.some((index) => selectedLinks[index]!.kind === 'channel')
            ? { callee: fact.callee } : {}),
          ...(fact.scheduling === 'sync' ? {} : { scheduling: fact.scheduling }),
        })
      } else {
        const detail = operationDetail(fact, lookup)
        entities.push({
          id: alias, kind: 'operation', operation_kind: fact.kind,
          owner: item[2], excerpt: excerpt!, detail,
        })
      }
      ownerProof.set(item[2], fact.kind === 'persistence'
        ? alias : ownerProof.get(item[2]) ?? alias)
      if (fact.kind === 'persistence') persisted.add(alias)
    }
  }
  const cover = (canonicalIds: readonly string[]): string[] => {
    const remaining = new Map(canonicalIds.map((id) => [entity(id), id]))
    const result: string[] = []
    for (const proof of hydration.proofs.values()) {
      if (proof[1] !== 'edge' || !remaining.has(proof[2]) || !remaining.has(proof[3])) continue
      result.push(proof[0]); remaining.delete(proof[2]); remaining.delete(proof[3])
    }
    for (const [subject, canonical] of remaining) {
      const hydrated = hydration.proofs.get(canonical)
      const proof = hydrated && hydrated[1] !== 'edge' ? subject : ownerProof.get(subject)
        ?? proofs.find((entry) => entry.from === subject || entry.to === subject)?.id
      if (!proof) return []
      result.push(proof)
    }
    return result.sort(compare)
  }
  const obligations: AnswerDossier['obligations'][number][] = []
  for (const obligation of selectedObligations) {
    const claimRefs = obligation.kind === 'handoff'
      ? obligation.edgeIds.map((id) => edge(id)![0])
      : obligation.kind === 'stage' && obligation.edgeIds.length > 0
        ? cover(obligation.symbolIds)
      : obligation.kind === 'ordering'
        ? obligation.operationIds.flatMap((id) => lookup(id) ? [entity(id)] : [])
        : obligation.kind === 'behavior' ? obligation.symbolIds.flatMap((id) => {
          const subject = entity(id)
          const edge = proofs.find((proof) => proof.from === subject)
          return edge?.id ?? ownerProof.get(subject) ?? []
        })
          : obligation.kind === 'subject' && plan.intent === 'locate' && plan.access
            ? obligation.operationIds.flatMap((id) => lookup(id) ? [entity(id)] : [])
          : obligation.kind === 'terminal'
            ? obligation.operationIds.flatMap((id) =>
              lookup(id) ? [entity(id)] : []).filter((proof) => persisted.has(proof))
            : cover(obligation.symbolIds)
    const unique = [...new Set(claimRefs)].sort(compare)
    if (obligation.mandatory && unique.length === 0) {
      return missingBuild('required_proof_missing', obligation.target, obligation.id)
    }
    obligations.push({
      id: obligation.id, kind: obligation.kind,
      statement: statement(obligation, plan),
      proofs: unique,
    })
  }
  const compactGroups = new Map<string, Omit<DossierOrderGroup, 'id'>>()
  for (const group of groups) {
    const controller = group.controllerOperationId
      ? lookup(group.controllerOperationId) : undefined
    const controllerFact = group.controllerOperationId
      ? index.operation_by_id.get(group.controllerOperationId) : undefined
    let detail: Readonly<Record<string, unknown>> | undefined
    if (controllerFact && ['condition', 'loop', 'parallel'].includes(controllerFact.kind)) {
      const { order: _order, ...control } = operationDetail(controllerFact, lookup)
      detail = control
    }
    const operationMembers = group.operationIds.flatMap((id) =>
      lookup(id) ? [entity(id)] : [])
    const members = group.kind === 'cycle'
      ? group.symbolIds.map(entity) : operationMembers
    const groupProofs = [...operationMembers]
    if (group.kind === 'cycle') {
      groupProofs.push(...links.filter((link) =>
        members.includes(link.from)
          && members.includes(link.to)).flatMap((link) => link.proofs))
    }
    if (groupProofs.length === 0) {
      return missingBuild('required_proof_missing', group.kind)
    }
    const preserveOrder = group.kind === 'sequence'
    const row: Omit<DossierOrderGroup, 'id'> = {
      kind: group.kind,
      ...(controller ? { controller } : {}),
      ...(group.arm ? { arm: group.arm } : {}),
      ...(detail ? { detail } : {}),
      members: preserveOrder
        ? members : [...new Set(members)].sort(compare),
      proofs: preserveOrder ? groupProofs : [...new Set(groupProofs)].sort(compare),
    }
    const key = JSON.stringify([
      row.kind, row.arm, row.controller, row.detail, row.members, row.proofs,
    ])
    const prior = compactGroups.get(key)
    compactGroups.set(key, prior ? { ...prior, depth: (prior.depth ?? 1) + 1 } : row)
  }
  const order = [...compactGroups.values()].map((row, index) =>
    ({ id: `g${index + 1}`, ...row }))
  const roots = rootIds.map(entity)
  const terminals = terminalIds.map(entity)
  return {
    state: 'ready',
    dossier: {
      query: query(plan),
      obligations,
      flow: {
        roots, terminals,
        links, order,
      },
      evidence: {
        digest_algorithm: 'sha256-base64url',
        files: [...hydration.files].map(([path, [alias, sha256]]) => ({
          id: alias, path,
          digest: Buffer.from(sha256, 'hex').toString('base64url'),
        })),
        excerpts: [...hydration.excerpts.values()].map(([alias, file, range, , text]) => ({
          id: alias, file,
          range: [
            range.start.line, range.start.column,
            range.end.line, range.end.column,
          ] as const,
          text,
        })),
        entities,
        proofs,
      },
    },
  }
}

function selectionMissing(selection: WorkflowSelection): MissingRequirement[] {
  const rows = new Map<string, MissingRequirement>()
  for (const entry of selection.missing) {
    const row: MissingRequirement = {
      code: entry.code,
      ...(entry.obligationId ? { obligation_id: entry.obligationId } : {}),
      ...(entry.target.length <= 96 ? { target: entry.target } : {}),
    }
    rows.set(`${row.code}\0${row.obligation_id ?? ''}\0${row.target ?? ''}`, row)
  }
  return [...rows.values()]
}

export function retrieveContext(index: QueryIndex, input: unknown): RetrieveContextResult {
  const request = normalizeRetrieveRequest(input)
  const planned = planQuestion(request)
  if (planned.status === 'unsupported') {
    return fitTerminal({
      ...header('unsupported', request),
      reason: planned.reason,
      terms: planned.terms.slice(0, 8).map((term) => term.slice(0, 32)),
    }, request.budget)
  }
  const plan = planned.plan
  if (index.state !== 'ready') return failure(request, index.state, index.subject)
  let selection: WorkflowSelection
  try {
    selection = selectWorkflow(index, plan)
  } catch {
    return failure(request, 'corrupt', 'workflow selection')
  }
  let hydration: InternalHydration
  const emittedOperationIds = emittedOperations(plan, selection, index)
  try {
    const validationOperationIds = selection.operationIds.filter((id) =>
      !emittedOperationIds.includes(id))
    hydration = hydrateEvidence(index, {
      symbolIds: selection.symbolIds,
      declarationSymbolIds: declarationTargets(plan, selection, index),
      operationIds: emittedOperationIds,
      validationOperationIds,
      edges: selection.edges,
    }) as InternalHydration
  } catch {
    return failure(request, 'corrupt', 'evidence hydration', selection)
  }
  if (hydration.state !== 'ready') {
    return failure(request, hydration.state, hydration.subject, selection)
  }
  if (!selection.complete) {
    return incomplete(
      request, plan, selectionMissing(selection), selection, hydration,
    )
  }
  const exceeded = hydration.files.size > MAX_RETRIEVE_FILES
    ? ['required_file_limit', hydration.files.size, MAX_RETRIEVE_FILES] as const
    : hydration.excerpts.size > MAX_RETRIEVE_EXCERPTS
      ? ['required_excerpt_limit', hydration.excerpts.size, MAX_RETRIEVE_EXCERPTS] as const
      : undefined
  if (exceeded) return incomplete(
    request, plan, limitMissing(exceeded[0], exceeded[1], exceeded[2]), selection, hydration,
  )
  try {
    const built = buildDossier(plan, selection, hydration, emittedOperationIds, index)
    if (built.state !== 'ready') return built.state === 'incomplete'
      ? incomplete(request, plan, [built.missing], selection, hydration, true)
      : failure(request, 'corrupt', built.subject, selection)
    const ready = stabilize({
      ...header('ready', request, selection, hydration),
      dossier: built.dossier,
    })
    if (ready.metrics.serialized_tokens > request.budget) {
      return incomplete(request, plan, limitMissing(
        'required_token_budget', ready.metrics.serialized_tokens, request.budget,
      ), selection, hydration)
    }
    return ready
  } catch {
    return failure(request, 'corrupt', 'dossier packing', selection)
  }
}

export function serializeRetrieveContextResult(result: RetrieveContextResult): string {
  return canonicalJsonString(result)
}
