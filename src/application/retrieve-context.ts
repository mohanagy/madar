import { countTokens as tokens } from 'gpt-tokenizer/encoding/cl100k_base'

import {
  hydrateEvidence,
} from './evidence-hydrator.js'
import { canonicalJsonString as json, compareCodeUnits as cmp } from '../domain/graph/canonical-json.js'
import type { IndexBodyFact, IndexValue } from '../domain/index/model.js'
import type { QueryIndex, ReadyQueryIndex } from '../domain/query/index-status.js'
import { planQuestion } from '../domain/query/plan.js'
import {
  selectWorkflow,
} from '../domain/query/workflow.js'
import {
  MAX_RETRIEVE_EXCERPTS as EXCERPTS,
  MAX_RETRIEVE_FILES as FILES,
  RETRIEVE_RESULT_SCHEMA,
  RETRIEVE_RESULT_VERSION,
  normalizeRetrieveRequest,
  valueHas,
  type AnswerDossier,
  type DossierEntity,
  type DossierLink,
  type DossierOrderGroup,
  type DossierProof,
  type EvidenceHydrationTargets,
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
const uniq = (values: Iterable<string>): string[] => [...new Set(values)].sort(cmp)
const cap = (
  code: 'required_file_limit' | 'required_excerpt_limit' | 'required_token_budget',
  required: number,
  limit: number,
): readonly MissingRequirement[] => [{ code, required, limit }]

function stat(
  req: NormalizedRetrieveRequest,
  flow?: WorkflowSelection,
  auth?: ReadyHydration,
  gaps = new Set<string>(),
): RetrieveMetrics {
  const must = flow?.obligations.filter(({ mandatory }) => mandatory) ?? []
  const data = flow?.metrics
  const roots = data?.rootCandidateCount ?? 0
  return {
    budget_tokens: req.budget,
    serialized_tokens: 0,
    selected_files: auth?.files.size ?? 0,
    authenticated_excerpts: auth?.excerpts.size ?? 0,
    required_obligations: must.length,
    proven_obligations: must.filter(({ proven, id }) => proven && !gaps.has(id)).length,
    optional_bundles_omitted: 0,
    root_candidates: roots,
    initial_candidates: data?.candidateCount ?? 0,
    explored_nodes: data?.actualNodeCount ?? 0,
    causal_hops: data?.causalRelationHops ?? 0,
    recovery_passes: data?.recoveryPasses ?? 0,
    recovery_frontier_nodes: data?.recoveryFrontierCount ?? 0,
    alternate_seeds: Math.max(0, roots - 1),
  }
}

function seal<T extends RetrieveContextResult>(out: T): T {
  out.metrics.serialized_tokens = 0
  const body = tokens(json(out)) - 1
  out.metrics.serialized_tokens = body + tokens(String(body + tokens(String(body))))
  return out
}

const base = <S extends RetrieveContextResult['state']>(
  state: S,
  req: NormalizedRetrieveRequest,
  flow?: WorkflowSelection,
  auth?: ReadyHydration,
  gaps?: Set<string>,
): { schema: typeof RETRIEVE_RESULT_SCHEMA; version: typeof RETRIEVE_RESULT_VERSION
    state: S; metrics: RetrieveMetrics } => ({
  schema: RETRIEVE_RESULT_SCHEMA, version: RETRIEVE_RESULT_VERSION,
  state, metrics: stat(req, flow, auth, gaps),
})

const ask = (plan: QueryPlan): QuerySummary =>
  ({ intent: plan.intent, subject: plan.subject, terms: plan.terms })

type TerminalResult = Exclude<RetrieveContextResult, { state: 'ready' }>
function fit(out: TerminalResult, max: number): TerminalResult {
  seal(out)
  if (out.metrics.serialized_tokens <= max) return out
  if (out.state === 'incomplete') {
    out.query.subject = out.query.subject.slice(0, 32)
    out.query.terms = []
    for (const row of out.missing) delete row.target
  } else if (out.state === 'unsupported') out.terms = []
  else for (const failure of out.failures) {
    failure.subject = failure.subject.slice(0, 32)
  }
  if (seal(out).metrics.serialized_tokens <= max) return out
  if (out.state === 'incomplete') {
    out.query.subject = ''
    if (seal(out).metrics.serialized_tokens <= max) return out
  }
  return seal({
    schema: out.schema, version: out.version, state: 'corrupt', metrics: out.metrics,
    failures: [{ state: 'corrupt', subject: 'terminal result budget' }],
  })
}

function select(
  plan: QueryPlan, flow: WorkflowSelection, index: ReadyQueryIndex,
): EvidenceHydrationTargets {
  const need = plan.intent === 'locate' ? flow.symbolIds.slice(0, 1) : []
  const focus = flow.obligations.find(({ kind, proven }) =>
    kind === 'subject' && proven)
  if (plan.intent === 'explain' && focus) need.push(...focus.symbolIds.slice(0, 1))
  const incident = new Set(flow.edges.flatMap(({ fromId, toId }) => [fromId, toId])),
    path = new Set([
    ...flow.rootSymbolIds, ...flow.terminalSymbolIds,
    ...flow.links.flatMap(({ fromId, toId }) => [fromId, toId]),
    ]), linked = new Set(flow.links.flatMap(({ operationIds }) => operationIds)),
    facts = new Set<string>()
  for (const id of flow.operationIds) {
    const fact = index.operation_by_id.get(id)
    if (!fact) continue
    incident.add(fact.owner_symbol_id)
    if (!['condition', 'loop', 'parallel'].includes(fact.kind)
      && !linked.has(id)
      && (fact.kind !== 'call' || path.has(fact.owner_symbol_id))) facts.add(id)
  }
  need.push(...flow.symbolIds.filter((id) => !incident.has(id)))
  for (const id of facts) {
    const fact = index.operation_by_id.get(id)
    if (fact?.kind === 'persistence') facts.add(fact.call_fact_id)
    if (fact?.kind === 'parallel') fact.member_fact_ids.forEach((member) => facts.add(member))
  }
  return {
    symbolIds: flow.symbolIds, edges: flow.edges,
    declarationSymbolIds: uniq(need),
    operationIds: uniq(facts),
    validationOperationIds: flow.operationIds.filter((id) => !facts.has(id)),
  }
}

function miss(
  req: NormalizedRetrieveRequest,
  plan: QueryPlan,
  missing: readonly MissingRequirement[],
  flow?: WorkflowSelection,
  auth?: ReadyHydration,
): RetrieveContextResult {
  const gaps = new Set(missing.flatMap((entry) =>
    entry.obligation_id ? [entry.obligation_id] : []))
  return fit({
    ...base('incomplete', req, flow, auth, gaps),
    query: ask(plan),
    missing,
  }, req.budget)
}

const fail = (
  req: NormalizedRetrieveRequest,
  state: 'stale' | 'unavailable' | 'corrupt',
  subject: string,
  flow?: WorkflowSelection,
): RetrieveContextResult => fit({
  ...base(state, req, flow),
  failures: [{ state, subject: subject.slice(0, 96) }],
}, req.budget)

function view(
  value: IndexValue, ref: (id: string) => string | undefined, brief: boolean,
): unknown {
  const nested = (entry: IndexValue): unknown => view(entry, ref, brief)
  if (value.kind === 'literal') return brief ? value.value : value
  if (value.kind === 'symbol') {
    const entity = ref(value.symbol_id)
    return brief ? entity ? { entity } : { unknown: 'outside_dossier' }
      : entity ? { kind: 'symbol', entity }
        : { kind: 'unknown', reason: 'outside_dossier' }
  }
  if (value.kind === 'array') return brief
    ? value.elements.map(nested)
    : { kind: 'array', elements: value.elements.map(nested) }
  if (value.kind === 'object') return brief ? {
    object: value.entries.map(({ key, value: entry }) => [key, nested(entry)]),
  } : { kind: 'object', entries: value.entries.map(({ key, value: entry }) => ({
    key, value: nested(entry),
  })) }
  if (value.kind === 'template') return brief
    ? { template: value.parts.map(nested) }
    : { kind: 'template', parts: value.parts.map(nested) }
  if (!brief) return value
  if (value.kind === 'parameter') return {
    parameter: value.position, ...(value.scope ? { scope: value.scope } : {}),
  }
  if (value.kind === 'redacted') return {
    redacted: value.sha256, bytes: value.byte_length,
  }
  return { unknown: value.reason }
}

const KEYS = {
  literal: ['role'], condition: ['condition_kind'], loop: ['loop_kind'],
  parallel: ['combinator', 'completion', 'lane_count'],
  return: [], throw: [], mutation: ['operation', 'target'],
  persistence: ['operation', 'receiver_type'],
} as const

function displayArm(arm: string): string {
  if (!arm.startsWith('case:')) return arm
  const encoded = arm.slice(5)
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (!Array.isArray(value) || value.length !== 2) return arm
    const [rawKind, scalar] = value
    const kind = rawKind === 'object' && scalar === null ? 'null' : rawKind
    const valid = kind === 'null' && scalar === null
      || kind === 'string' && typeof scalar === 'string'
      || kind === 'boolean' && typeof scalar === 'boolean'
      || kind === 'number' && typeof scalar === 'number' && Number.isFinite(scalar)
    if (!valid || Buffer.from(json(value)).toString('base64url') !== encoded) return arm
    return `case:${String(kind)}:${json(scalar)}`
  } catch {
    return arm
  }
}

function info(
  fact: IndexBodyFact,
  ref: (id: string) => string | undefined,
): Readonly<Record<string, unknown>> {
  const value = (entry: IndexValue | undefined): Record<string, unknown> | undefined =>
    entry === undefined ? undefined : view(entry, ref, false) as Record<string, unknown>
  if (fact.kind === 'call') {
    const target = fact.target_symbol_id ? ref(fact.target_symbol_id) : undefined
    const args = fact.arguments.some((entry) => valueHas(
      entry, (candidate) => candidate.kind === 'literal',
    )) ? fact.arguments.map((entry) => view(entry, ref, false)) : undefined
    return { callee: fact.callee,
      ...(target ? { target } : {}), ...(args ? { arguments: args } : {}) }
  }
  if (fact.kind === 'condition') return {
    kind: fact.condition_kind,
    ...(fact.test === undefined ? {} : { test: view(fact.test, ref, true) }),
  }
  if (fact.kind === 'loop') return {
    kind: fact.loop_kind,
    ...(fact.test === undefined ? {} : { test: view(fact.test, ref, true) }),
  }
  if (fact.kind === 'parallel') return {
    combinator: fact.combinator, completion: fact.completion,
    lanes: fact.lane_count,
    ...(fact.input === undefined ? {} : { input: view(fact.input, ref, true) }),
  }
  const row: Record<string, unknown> = {}
  const raw = fact as unknown as Record<string, unknown>
  for (const key of KEYS[fact.kind]) row[key] = raw[key]
  if (fact.kind === 'persistence') {
    row.call = ref(fact.call_fact_id)!
    const resource = value(fact.resource)
    if (resource && !(resource.kind === 'symbol'
      && resource.entity === ref(fact.owner_symbol_id))) row.resource = resource
  } else if (['literal', 'return', 'throw', 'mutation'].includes(fact.kind)) {
    const item = raw.value as IndexValue | undefined
    if (item !== undefined) row.value = value(item)
  }
  return row
}

function pack(
  plan: QueryPlan,
  flow: WorkflowSelection,
  auth: ReadyHydration,
  index: ReadyQueryIndex,
): AnswerDossier | MissingRequirement {
  const {
    rootSymbolIds: roots, terminalSymbolIds: ends,
    links: paths, controlGroups: groups, obligations: claims,
  } = flow
  const get = (id: string): string | undefined => auth.entities.get(id)?.[0]
  const ref = get as (id: string) => string
  const coords = (range: IndexBodyFact['evidence']['range']):
    [number, number, number, number] => [
    range.start.line, range.start.column, range.end.line, range.end.column,
  ]
  const refs: DossierProof[] = []
  for (const proof of auth.proofs.values()) {
    if (proof[1] === 'edge') refs.push({
      id: proof[0], from: proof[2], to: proof[3],
      relation: proof[4], excerpt: proof[5],
    })
    else if (proof[1] === 'edge_range') refs.push({
      id: proof[0], from: proof[2], to: proof[3], relation: proof[4],
      file: proof[5], range: coords(proof[6]),
    })
  }
  const tied = new Map<string, string[]>()
  const pathProofs = paths.map((link) => {
    const proofs = [...new Set(link.edgeIds.map((id) => auth.proofs.get(id)![0]))]
    link.operationIds.forEach((id) => tied.set(
      id, uniq([...(tied.get(id) ?? []), ...proofs]),
    ))
    return proofs
  })
  const folded = new Map<number, number>(), consumed = new Set<number>()
  paths.forEach((path, index) => {
    if (path.kind !== 'direct') return
    const incoming = paths.flatMap((candidate, candidateIndex) =>
      candidate.toId === path.toId ? [candidateIndex] : [])
    const outgoing = paths.flatMap((candidate, candidateIndex) =>
      candidate.fromId === path.toId ? [candidateIndex] : [])
    if (incoming.length !== 1 || outgoing.length !== 1) return
    const nextIndex = outgoing[0]!, next = paths[nextIndex]!
    if (next.kind !== 'channel') return
    const alreadyPublished = paths.some((candidate, candidateIndex) =>
      candidateIndex !== index && candidateIndex !== nextIndex
      && candidate.fromId === path.fromId && candidate.toId === next.toId)
    if (alreadyPublished) return
    folded.set(index, nextIndex); consumed.add(nextIndex)
  })
  const links: DossierLink[] = []
  paths.forEach((path, index) => {
    if (consumed.has(index)) return
    const nextIndex = folded.get(index), next = nextIndex === undefined
      ? undefined : paths[nextIndex]
    links.push({
      id: `l${links.length + 1}`,
      kind: next ? 'channel' : path.kind,
      from: ref(path.fromId), to: ref(next?.toId ?? path.toId),
      proofs: nextIndex === undefined ? pathProofs[index]!
        : [...new Set([...pathProofs[index]!, ...pathProofs[nextIndex]!])],
    })
  })
  const opRefs = (ids: readonly string[]): string[] => uniq(ids.flatMap((id) =>
    tied.get(id) ?? (get(id) ? [ref(id)] : [])))
  const resolve = (id: string): string | undefined =>
    tied.get(id)?.[0] ?? get(id)
  const owned = new Map<string, string>()
  const ents = [...auth.entities].flatMap(([
    id, item,
  ]): DossierEntity[] => {
    const alias = item[0]
    const proof = auth.proofs.get(id)
    const excerpt = proof?.[1] === 'declaration' || proof?.[1] === 'operation'
      ? proof[3] : undefined
    if (item[1] === 'symbol') {
      return [{
        id: alias, kind: 'symbol', label: item[2],
        ...(/^(?:function|method|class)$/u.test(item[3])
          ? {} : { node_kind: item[3] }),
        file: item[4],
        ...(excerpt ? { excerpt } : {}),
      }]
    }
    if (item[1] === 'channel') {
      const parent = item[5] ? ref(item[5]) : undefined
      return [{
        id: alias, kind: 'channel', channel_kind: item[2],
        transport: item[3], key: item[4],
        ...(parent ? { parent } : {}),
        ...(item[6] ? { scope: item[6] } : {}),
      }]
    }
    const fact = item[3]
    const repl = tied.get(id)
    owned.set(item[2], fact.kind === 'persistence'
      ? alias : owned.get(item[2]) ?? repl?.[0] ?? alias)
    return repl ? [] : [{
      id: alias, kind: 'operation', operation_kind: fact.kind,
      owner: item[2], excerpt: excerpt!, detail: info(fact, resolve),
    }]
  })
  const cover = (ids: readonly string[], behavior = false): string[] => {
    const result = ids.flatMap((id) => {
      const subject = ref(id)
      const hydrated = auth.proofs.get(id)
      const proof = behavior
        ? refs.find((entry) => entry.from === subject)?.id ?? owned.get(subject)
        : hydrated && (hydrated[1] === 'declaration' || hydrated[1] === 'operation')
          ? subject : owned.get(subject)
          ?? refs.find((entry) => entry.from === subject || entry.to === subject)?.id
      return proof ? [proof] : []
    })
    return behavior || result.length === ids.length ? uniq(result) : []
  }
  type ControlKind = 'branch' | 'loop' | 'parallel'
  type Chain = [
    kind: ControlKind, arm: string | undefined, owner: string, file: string,
    ids: string[], ranges: [number, number, number, number][],
    sets: string[][], detail: Readonly<Record<string, unknown>>,
  ]
  const chains: Chain[] = []
  for (const group of groups) {
    const id = group.controllerOperationId
    if (!id || !['branch', 'loop', 'parallel'].includes(group.kind)) continue
    const fact = index.operation_by_id.get(id), proof = auth.controls.get(id)
    if (!fact || !proof || !['condition', 'loop', 'parallel'].includes(fact.kind)) {
      return { code: 'required_proof_missing', target: plan.subject }
    }
    const members = opRefs(group.operationIds)
    if (members.length === 0) continue
    const detail = info(fact, resolve), owner = ref(fact.owner_symbol_id)
    const parent = [...fact.control].reverse().find((frame) =>
      frame.kind === group.kind
        && (frame.kind !== 'branch' || frame.arm === group.arm))
    const prior = parent && 'controller_fact_id' in parent
      ? [...chains].reverse().find((chain) =>
        chain[4].at(-1) === parent.controller_fact_id
          && chain[0] === group.kind && chain[1] === group.arm
          && chain[2] === owner && chain[3] === proof[0]
          && json(chain[7]) === json(detail)
          && members.every((member) => chain[6].at(-1)!.includes(member)))
      : undefined
    if (prior) {
      prior[4].push(id); prior[5].push(coords(proof[1])); prior[6].push(members)
    } else {
      chains.push([group.kind as ControlKind, group.arm, owner, proof[0],
        [id], [coords(proof[1])], [members], detail])
    }
  }
  const byFile = new Map<string, [number, number, number, number][]>()
  for (const chain of chains) {
    const ranges = byFile.get(chain[3]) ?? []
    for (const range of chain[5]) {
      if (!ranges.some((candidate) => json(candidate) === json(range))) {
        ranges.push(range)
      }
    }
    byFile.set(chain[3], ranges)
  }
  const controls: AnswerDossier['evidence']['controls'][number][] =
    [...byFile].sort(([left], [right]) => cmp(left, right)).map(([
      file, ranges,
    ], index) => ({
      id: `c${index + 1}`, file,
      ranges: ranges.sort((left, right) => {
        for (let part = 0; part < left.length; part += 1) {
          const order = left[part]! - right[part]!
          if (order !== 0) return order
        }
        return 0
      }),
    }))
  const control = (chain: Chain): string => {
    const catalog = controls.find(({ file }) => file === chain[3])!
    const indexes = chain[5].map((range) => catalog.ranges.findIndex(
      (candidate) => json(candidate) === json(range)))
    const sequential = indexes.every((index, offset) =>
      index === indexes[0]! + offset)
    const selector = sequential && indexes.length > 1
      ? `${indexes[0]}-${indexes.at(-1)}` : indexes.join('.')
    return `${catalog.id}:${selector}`
  }
  const order: DossierOrderGroup[] = chains.map((chain) => {
    const controller = control(chain)
    const layers = chain[6].map((set, layer) => set.filter((member) =>
      !(chain[6][layer + 1] ?? []).includes(member)))
    const members = layers.flat()
    return {
      id: '', kind: chain[0], controller,
      ...(chain[1] ? { arm: displayArm(chain[1]) } : {}), detail: chain[7],
      ...(layers.length > 1 ? {
        depths: layers.flatMap((layer, depth) => layer.map(() => depth)),
      } : {}),
      members,
    }
  })
  for (const group of groups) {
    if (group.controllerOperationId) continue
    const ops = opRefs(group.operationIds)
    const nodes = group.kind === 'cycle' ? group.symbolIds.map(ref) : ops
    const proofs = group.kind === 'cycle'
      ? [...ops, ...links.filter((link) => nodes.includes(link.from)
        && nodes.includes(link.to)).flatMap((link) => link.proofs)] : ops
    if (nodes.length === 0 || proofs.length === 0
      || group.kind === 'sequence' && nodes.length < 2) continue
    order.push({
      id: '', kind: group.kind,
      members: group.kind === 'sequence' ? nodes : uniq(nodes),
      ...(group.kind === 'cycle' ? { proofs: uniq(proofs) } : {}),
    })
  }
  order.forEach((group, index) => { group.id = `g${index + 1}` })
  const collapse = (
    raw: readonly string[], bundles: readonly {
      id: string; proofs: readonly string[]
    }[],
  ): string[] => {
    const wanted = new Set(raw)
    const used = bundles.filter(({ proofs }) => proofs.some((id) => wanted.has(id)))
    const covered = new Set(used.flatMap(({ proofs }) => proofs))
    const packed = [...used.map(({ id }) => id), ...raw.filter((id) => !covered.has(id))]
    return packed.length < raw.length ? packed : [...raw]
  }
  const linkBundles = links.map(({ id, proofs }) => ({ id, proofs }))
  const orderBundles = order.map(({ id, members, proofs = [] }) => ({
    id, proofs: [...members, ...proofs],
  }))
  const claimsOut: AnswerDossier['obligations'][number][] = []
  for (const claim of claims) {
    const useOps = claim.kind === 'ordering' || claim.kind === 'terminal'
      || claim.kind === 'subject' && plan.intent === 'locate' && !!plan.access
    const raw = claim.kind === 'handoff'
      ? claim.edgeIds.map((id) => auth.proofs.get(id)![0])
      : claim.kind === 'behavior'
        ? uniq([...cover(claim.symbolIds, true), ...opRefs(claim.operationIds)])
        : useOps ? opRefs(claim.operationIds) : cover(claim.symbolIds)
    const refs = uniq(claim.kind === 'ordering'
      ? collapse(raw, orderBundles)
      : ['stage', 'handoff', 'behavior'].includes(claim.kind)
        ? collapse(raw, linkBundles) : raw)
    if (claim.mandatory && refs.length === 0) {
      return {
        code: 'required_proof_missing', target: claim.target,
        obligation_id: claim.id,
      }
    }
    claimsOut.push({
      id: claim.id, kind: claim.kind,
      statement: claim.kind === 'subject' ? `${plan.subject}.` : `${claim.kind} proven.`,
      proofs: refs,
    })
  }
  return {
    query: ask(plan), obligations: claimsOut,
    flow: { roots: roots.map(ref), terminals: ends.map(ref), links, order },
    evidence: {
      digest_algorithm: 'sha256-base64url',
      files: [...auth.files].map(([path, [id, sha256]]) => ({
        id, path, digest: Buffer.from(sha256, 'hex').toString('base64url'),
      })),
      excerpts: [...auth.excerpts.values()].map(([id, file, range, , text]) => ({
        id, file, range: [range.start.line, range.start.column,
          range.end.line, range.end.column], text,
      })),
      controls, entities: ents, proofs: refs,
    },
  }
}

export function retrieveContext(index: QueryIndex, input: unknown): RetrieveContextResult {
  const req = normalizeRetrieveRequest(input)
  const planned = planQuestion(req)
  if (planned.status === 'unsupported') {
    return fit({
      ...base('unsupported', req),
      reason: planned.reason,
      terms: planned.terms.slice(0, 8).map((term) => term.slice(0, 32)),
    }, req.budget)
  }
  const plan = planned.plan
  if (index.state !== 'ready') return fail(req, index.state, index.subject)
  let flow: WorkflowSelection
  try {
    flow = selectWorkflow(index, plan)
  } catch {
    return fail(req, 'corrupt', 'workflow selection')
  }
  let auth: HydratedEvidenceResult
  try {
    auth = hydrateEvidence(index, select(plan, flow, index))
  } catch {
    return fail(req, 'corrupt', 'evidence hydration', flow)
  }
  if (auth.state !== 'ready') {
    return fail(req, auth.state, auth.subject, flow)
  }
  if (!flow.complete) {
    return miss(req, plan, flow.missing.map((entry): MissingRequirement => ({
      code: entry.code,
      ...(entry.obligationId ? { obligation_id: entry.obligationId } : {}),
      ...(entry.target.length <= 96 ? { target: entry.target } : {}),
    })), flow, auth)
  }
  const over = auth.files.size > FILES
    ? ['required_file_limit', auth.files.size, FILES] as const
    : auth.excerpts.size > EXCERPTS
      ? ['required_excerpt_limit', auth.excerpts.size, EXCERPTS] as const
      : undefined
  if (over) return miss(
    req, plan, cap(over[0], over[1], over[2]), flow, auth,
  )
  try {
    const built = pack(plan, flow, auth, index)
    if ('code' in built) return miss(
      req, plan, [built], flow, auth)
    const ready = seal({
      ...base('ready', req, flow, auth),
      dossier: built,
    })
    if (ready.metrics.serialized_tokens > req.budget) return miss(
      req, plan, cap('required_token_budget',
        ready.metrics.serialized_tokens, req.budget), flow, auth,
    )
    return ready
  } catch {
    return fail(req, 'corrupt', 'dossier packing', flow)
  }
}

export function serializeRetrieveContextResult(result: RetrieveContextResult): string {
  return json(result)
}
