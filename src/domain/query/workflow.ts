import { compareCodeUnits as cmp } from '../graph/canonical-json.js'
import type { GraphAttributes } from '../graph/directed-multigraph.js'
import type { IndexBodyFact, IndexValue } from '../index/model.js'
import type { ReadyQueryIndex } from './index-status.js'
import { lexicalTokens as words } from './plan.js'
import { sourceDomainOf as domainOf, type SourceDomain } from './source-domain.js'
import {
  valueHas, type ObligationKind, type QueryObligation, type QueryPlan,
  type WorkflowControlGroup, type WorkflowMissingCode, type WorkflowMissingReason,
  type WorkflowObligationProof, type WorkflowRelation, type WorkflowSelection,
} from './types.js'
const [CANDIDATES, NODES, HOPS, RECOVERY] = [32, 512, 24, 64]
const FAILURE_WORD = /^(?:abort|cancel|error|fail(?:ed|ure)?|refund|reject(?:ed)?|retry|rollback)$/u,
  READ = /^(?:read|file_read|object_read)$/u,
  GENERIC_TERMINAL = /^(?:data|output|persist|persistence|record|report|result|storage|store|write)$/u,
  DATABASE = /^(?:database|db|mongo|mongodb|repository|sql)$/u
const MISSING_CODES: Partial<Record<QueryObligation['kind'], WorkflowMissingCode>> = {
  handoff: 'adjacent_handoff_unproven', behavior: 'behavior_unproven',
  subject: 'subject_unproven', entry: 'entrypoint_unproven',
  terminal: 'terminal_persistence_unproven',
}
type SymbolNode = readonly [
  id: string, compact: string, nameCompact: string,
  tokens: ReadonlySet<string>, nameTokens: ReadonlySet<string>,
  facts: readonly IndexBodyFact[], persists: boolean,
  domain: SourceDomain, requestEntry: boolean,
]
type IndexedEdge = readonly [
  id: string, from: string, to: string, relation: WorkflowRelation,
  evidence: string, owner: string, operation: string,
  dispatchPayload: number | undefined,
]
type Arc = readonly [
  from: string, to: string, kind: 'direct' | 'channel',
  edges: readonly IndexedEdge[], ops: readonly string[],
]
type ExecutionView = readonly [
  nodes: readonly SymbolNode[], byId: ReadonlyMap<string, SymbolNode>,
  outgoing: ReadonlyMap<string, readonly Arc[]>,
  incoming: ReadonlyMap<string, readonly Arc[]>, blocked: ReadonlySet<string>,
  nonEntries: ReadonlySet<string>, ops: ReadonlyMap<string, IndexBodyFact>,
]
type Candidate = readonly [
  symbol: SymbolNode, lexical: number, rank: number,
  affinity: number, exact: number,
]
type Reach = readonly [
  dist: Map<string, number>, actual: Set<string>, bounded: boolean,
  prev: Map<string, Arc>,
]
type Selection = readonly [
  nodes: Set<string>, arcs: Arc[], ends: string[],
  actual: Set<string>, bounded: boolean,
]
type Control = readonly [
  ops: string[], groups: WorkflowControlGroup[], proven: boolean,
  terminalOperations: string[],
]
const cache = new WeakMap<ReadyQueryIndex, ExecutionView>()
function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.get(key)?.push(value) ?? map.set(key, [value])
}
const text = (attrs: GraphAttributes, key: string): string =>
  typeof attrs[key] === 'string' ? attrs[key] : ''
const factText = (fact: IndexBodyFact): string =>
  fact.kind === 'call' ? fact.callee
    : fact.kind === 'persistence'
      ? `${fact.receiver_type} ${JSON.stringify(fact.resource ?? '')}`
      : fact.kind === 'mutation' ? fact.target
        : fact.kind === 'literal' ? JSON.stringify(fact.value)
          : fact.kind === 'return' || fact.kind === 'throw'
            ? `${fact.kind} ${JSON.stringify(fact.value ?? '')}`
          : fact.kind
const behavior = (fact: IndexBodyFact): boolean => fact.kind !== 'literal'
const adverse = (value: string): boolean => words(value).some((word) =>
  word !== 'retry' && FAILURE_WORD.test(word))
const terminal = (
  fact: IndexBodyFact,
): fact is Extract<IndexBodyFact, { kind: 'persistence' }> =>
  fact.kind === 'persistence' && !READ.test(fact.operation)
function bad(fact: IndexBodyFact | undefined): boolean {
  return !!fact && (fact.control.some((frame) =>
    frame.kind === 'exception' && frame.arm === 'catch')
    || fact.kind === 'call'
    && (adverse(fact.callee)
    || fact.arguments.some((argument) =>
        valueHas(argument, (value) => value.kind === 'literal'
          && typeof value.value === 'string'
          && adverse(value.value)))))
}
const hasTerminal = (v: ExecutionView, id: string, adverse: boolean): boolean =>
  v[1].get(id)?.[5].some((fact) => terminal(fact)
    && (adverse || !bad(fact) && !bad(v[6].get(fact.call_fact_id)))) ?? false
type LooseRange = {
  start?: { line?: unknown; column?: unknown }
  end?: { line?: unknown; column?: unknown }
} | undefined
function rangeKey(value: unknown): string {
  return `${(value as LooseRange)?.start?.line}:${(value as LooseRange)?.start?.column
  }:${(value as LooseRange)?.end?.line}:${(value as LooseRange)?.end?.column}`
}
const idsOf = (arc: Arc): string[] => arc[3].map((edge) => edge[0])
const penalty = (domain: SourceDomain): number =>
  domain === 'production' ? 0 : domain === 'unknown' ? 4 : 32
function isRequest(attrs: GraphAttributes): boolean {
  const role = text(attrs, 'framework_role'),
    kind = text(attrs, 'node_kind')
  return kind === 'route'
    || /(?:_route|_api|_server_action|router_(?:loader|action)|trpc_procedure_)/u
      .test(role)
}
function buildView(i: ReadyQueryIndex): ExecutionView {
  const prior = cache.get(i)
  if (prior) return prior
  const nodes: SymbolNode[] = []
  for (const [id, attrs] of i.graph.nodeEntries()) {
    if (['channel', 'file'].includes(text(attrs, 'node_kind'))) continue
    const facts = i.operations_by_owner.get(id) ?? [],
      file = text(attrs, 'source_file'),
      name = [
        text(attrs, 'label'), text(attrs, 'qualified_name'),
        text(attrs, 'node_kind'), text(attrs, 'framework_role'),
      ].join(' '),
      nameWords = words(name),
      lexicon = words([name, file, ...facts.map(factText)].join(' '))
    nodes.push([id, lexicon.join(''), nameWords.join(''),
      new Set(lexicon), new Set(nameWords), facts, facts.some(terminal),
      domainOf(attrs.source_domain, file, i.root_path), isRequest(attrs)])
  }
  const byId = new Map(nodes.map((symbol) => [symbol[0], symbol])),
    exact = new Map<string, IndexedEdge>(),
    routes = new Map<string, IndexedEdge[]>(),
    subs = new Map<string, IndexedEdge[]>(), pubs: IndexedEdge[] = [],
    nonEntries = new Set<string>()
  for (const [from, to, attrs, id] of i.graph.edgeEntries()) {
    const relation = String(attrs.relation) as WorkflowRelation
    const evidence = attrs.evidence as {
      source?: unknown; range?: unknown; statement_range?: unknown
      excerpt_sha256?: unknown
    } | undefined
    if (!['calls', 'publishes_to', 'routes_through', 'consumed_by'].includes(relation)
      || !/^(?:typescript-(?:semantic|syntactic)|framework-decorator|wrapper-summary)$/u
        .test(String(evidence?.source))) continue
    const owner = text(attrs, 'execution_owner_id'),
      edgeRange = rangeKey(evidence?.range),
      statement = rangeKey(evidence?.statement_range),
      bind = relation === 'publishes_to' ? from
        : relation === 'consumed_by' && owner !== to ? owner : '',
      calls = bind ? (i.operations_by_owner.get(bind) ?? []).filter((fact) =>
          fact.kind === 'call'
          && (relation === 'consumed_by' || rangeKey(fact.evidence.range)
            === edgeRange)
          && rangeKey(fact.evidence.statement_range) === statement
          && fact.evidence.excerpt_sha256 === evidence?.excerpt_sha256)
        : [],
      payload = attrs.dispatch_payload_argument,
      edge: IndexedEdge = [id, from, to, relation,
        `${edgeRange}\0${statement}`, owner, calls.length === 1 ? calls[0]!.id : '',
        typeof payload === 'number' && Number.isSafeInteger(payload) && payload >= 0
          ? payload : undefined]
    if (byId.has(to) && (relation === 'consumed_by'
      || relation === 'calls' && byId.get(from)?.[7] === 'production')) nonEntries.add(to)
    if (relation === 'calls') {
      const key = `c\0${from}\0${to}\0${edgeRange}`
      if (!exact.has(key)) exact.set(key, edge)
    }
    else if (relation === 'routes_through') append(routes, `${from}\0${to}`, edge)
    else if (relation === 'consumed_by') append(subs, from, edge)
    else pubs.push(edge)
  }
  let arcs: Arc[] = []
  for (const owner of nodes) {
    for (const fact of owner[5]) {
      if (fact.kind !== 'call' || !fact.target_symbol_id
        || !byId.has(fact.target_symbol_id)) continue
      const edge = exact.get(
        `c\0${owner[0]}\0${fact.target_symbol_id}\0${rangeKey(fact.evidence.range)}`,
      )
      if (edge) arcs.push([owner[0], fact.target_symbol_id, 'direct', [edge], [fact.id]])
    }
  }
  for (const pub of pubs) {
    if (!byId.has(pub[1]) || !i.channels_by_id.has(pub[2])) continue
    const channel = i.channels_by_id.get(pub[2])!,
      routed = channel.channel_kind === 'job'
        ? (routes.get(`${channel.id}\0${channel.parent_channel_id}`) ?? [])
          .filter((edge) => edge[5] === pub[1] && edge[4] === pub[4])
        : [],
      route = routed.length === 1 ? routed[0] : undefined
    if (channel.channel_kind === 'job' && !route) continue
    const dest = route?.[2] ?? channel.id
    for (const sub of subs.get(dest) ?? []) {
      if (!byId.has(sub[2])) continue
      const binding = !sub[5] || sub[5] === sub[2]
        ? [] : sub[6] ? [sub[6]] : undefined
      if (!binding) continue
      const edges = route ? [pub, route, sub] : [pub, sub]
      arcs.push([pub[1], sub[2], 'channel', edges,
        pub[6] ? [pub[6], ...binding] : []])
    }
  }
  const hidden = new Set<string>()
  arcs = arcs.filter((arc) => arc[2] !== 'channel' || !arc[4].some((id) => {
    const fact = i.operation_by_id.get(id)
    if (fact?.kind !== 'call' || !fact.target_symbol_id) return false
    const redundant = arcs.some((direct) => direct[0] === arc[0]
      && direct[1] === fact.target_symbol_id && direct[2] === 'direct'
      && direct[4].includes(id))
      && arcs.some((inner) => inner[0] === fact.target_symbol_id
        && inner[1] === arc[1] && inner[2] === 'channel')
    if (redundant) arc[3].forEach((edge) => hidden.add(edge[0]))
    return redundant
  }))
  arcs.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1])
    || cmp(a[3][0]![0], b[3][0]![0]))
  const outgoing = new Map<string, Arc[]>(), incoming = new Map<string, Arc[]>()
  for (const arc of arcs) {
    append(outgoing, arc[0], arc); append(incoming, arc[1], arc)
  }
  const used = new Set([...arcs.flatMap(idsOf), ...hidden]),
    blocked = new Set(pubs.filter((edge) => byId.has(edge[1])
      && !used.has(edge[0])).map((edge) => edge[1])),
    v: ExecutionView = [
      nodes, byId, outgoing, incoming, blocked, nonEntries, i.operation_by_id,
    ]
  cache.set(i, v)
  return v
}
function score(symbol: SymbolNode, goals: readonly string[]): number {
  let result = 0
  for (const target of goals) {
    const terms = words(target), compact = terms.join('')
    if (symbol[2].includes(compact)) result += 128
    if (terms.every((term) => symbol[4].has(term))) result += 64
    if (symbol[1].includes(compact)) result += 32
    for (const term of terms) {
      if (symbol[3].has(term)) result += 8
      if (symbol[4].has(term)) result += 8
    }
  }
  return result
}
function rootRank(v: ExecutionView, symbol: SymbolNode, lexical: number): number {
  const degree = (v[3].get(symbol[0])?.length ?? 0)
      + (v[2].get(symbol[0])?.length ?? 0)
      + (v[4].has(symbol[0]) ? 1 : 0)
  return lexical - penalty(symbol[7]) - Math.min(24, Math.max(0, degree - 8) * 2)
    - (degree === 0 && !symbol[6] ? 12 : 0)
    - (symbol[6] ? 16 : 0)
}
function adverseArc(v: ExecutionView, arc: Arc): boolean {
  return arc[4].some((id) => {
    const fact = v[6].get(id)
    if (bad(fact)) return true
    if (arc[2] !== 'channel' || fact?.kind !== 'call' || !fact.target_symbol_id) {
      return false
    }
    const matching = (v[2].get(fact.target_symbol_id) ?? []).filter((inner) =>
      inner[2] === 'channel' && inner[1] === arc[1])
    return matching.length > 0 && matching.every((inner) =>
      inner[4].some((operation) => bad(v[6].get(operation))))
  })
}
function reach(
  v: ExecutionView, seeds: readonly string[], back: boolean,
  cap: number, allow?: (arc: Arc) => boolean,
  allowed?: { has(id: string): boolean }, stops?: ReadonlySet<string>,
): Reach {
  const dist = new Map(seeds.map((seed) => [seed, 0]))
  const actual = new Set(seeds), queue = [...seeds]
  const prev = new Map<string, Arc>(), extra = new Set<string>()
  let bounded = false
  while (queue.length > 0) {
    queue.sort((left, right) => dist.get(left)! - dist.get(right)!
      || cmp(left, right))
    const at = queue.shift()!
    if (stops?.has(at)) continue
    const base = dist.get(at)!,
      arcs = (back ? v[3] : v[2]).get(at) ?? []
    for (const arc of arcs) {
      if (allow && !allow(arc)) continue
      const next = back ? arc[0] : arc[1], hops = base + arc[3].length
      if (hops > HOPS) { extra.add(next); continue }
      if ((allowed && !allowed.has(next)) || (dist.get(next) ?? Infinity) <= hops) continue
      const added = [...new Set(arc[3].flatMap((edge) => [edge[1], edge[2]]))]
        .filter((id) => !actual.has(id))
      if (actual.size + added.length > cap) { bounded = true; continue }
      added.forEach((id) => actual.add(id))
      dist.set(next, hops)
      prev.set(next, arc)
      if (!queue.includes(next)) queue.push(next)
    }
  }
  return [
    dist, actual, bounded || [...extra].some((id) => !dist.has(id)),
    prev,
  ]
}
function orderBy(
  left: readonly number[], right: readonly number[],
): number {
  let i = 0
  while (i < left.length && i < right.length && left[i] === right[i]) i += 1
  return (left[i] ?? 0) - (right[i] ?? 0) || left.length - right.length
}
function corridor(
  v: ExecutionView, root: string, cap: number, goals: readonly string[],
  fail: boolean, endNeed?: string, channelEnd = false,
): Selection {
  const allow = fail ? undefined : (arc: Arc) => !adverseArc(v, arc),
    fwd = reach(v, [root], false, cap, allow)
  const found = [...fwd[0].keys()].filter((id) =>
      hasTerminal(v, id, fail)),
    wanted = endNeed
      ? pickIds(v, found, endNeed, 'terminal') : [],
    options = endNeed ? wanted : found,
    sinceChannel = (id: string): number => {
      let direct = 0
      for (let at = id; at !== root;) {
        const arc = fwd[3].get(at)
        if (!arc) return Infinity
        if (arc[2] === 'channel') return direct
        direct += 1; at = arc[0]
      }
      return Infinity
    },
    originals = options.filter((id) => v[1].get(id)?.[5].some((fact) =>
      terminal(fact) && fact.source !== 'wrapper-summary')),
    terminalOptions = originals.length > 0 ? originals : options,
    channelDistance = channelEnd
      ? Math.min(...terminalOptions.map(sinceChannel)) : Infinity,
    channelOptions = Number.isFinite(channelDistance)
      ? terminalOptions.filter((id) => sinceChannel(id) === channelDistance) : [],
    eligible = channelOptions.length > 0 ? channelOptions : terminalOptions
  const exact = pickIds(
      v, eligible, goals[0] ?? '', 'exact',
    ),
    related = exact.length > 0 ? exact
      : eligible.filter((id) => score(v[1].get(id)!, goals) > 0),
    zone = related.length > 0
      ? reach(v, related, false, cap, allow, fwd[0])[0] : undefined,
    pool = (zone ? eligible.filter((id) => zone.has(id)) : eligible)
    .sort((left, right) => fwd[0].get(right)! - fwd[0].get(left)!
      || score(v[1].get(right)!, goals) - score(v[1].get(left)!, goals)
      || cmp(left, right))
  const allowed = fwd[0]
  let ends = pool.filter((id) => {
    const below = reach(
      v, [id], false, cap, allow, allowed,
    )[0]
    return !pool.some((other) => other !== id && below.has(other))
  })
  if (ends.length === 0) ends = pool.slice(0, 1)
  const exactEnds = ends.filter((id) =>
    exact.includes(id))
  if (exactEnds.length > 0) ends = exactEnds
  const chosen = ends.length > 0 ? fwd
      : reach(v, [root], false, cap, allow, undefined, v[4]),
    backward = reach(v, ends, true, cap, allow, allowed)
  let nodes = new Set([...chosen[0].keys()].filter((id) =>
    ends.length === 0 || backward[0].has(id)))
  let arcs = [...v[2].values()].flat().filter((arc) =>
    nodes.has(arc[0]) && nodes.has(arc[1]) && (!allow || allow(arc)))
  const hopCount = new Set(arcs.flatMap(idsOf)).size
  const pruned = hopCount > HOPS
  if (pruned) {
    const walks = ends.map((terminal) => {
      const path: Arc[] = []
      for (let id = terminal; id !== root;) {
        const arc = fwd[3].get(id)
        if (!arc) return []
        path.unshift(arc); id = arc[0]
      }
      return path
    })
    const need = [...new Map(walks.flat().map((arc) =>
      [idsOf(arc).join('\0'), arc])).values()]
    arcs = new Set(need.flatMap(idsOf)).size <= HOPS ? need : walks[0] ?? []
    nodes = new Set([root, ...arcs.flatMap((arc) => [arc[0], arc[1]])])
  }
  arcs.sort((left, right) =>
    (fwd[0].get(left[0]) ?? Infinity) - (fwd[0].get(right[0]) ?? Infinity)
    || (fwd[0].get(left[1]) ?? Infinity) - (fwd[0].get(right[1]) ?? Infinity)
    || cmp(left[0], right[0]) || cmp(left[1], right[1])
    || cmp(left[3][0]![0], right[3][0]![0]))
  return [nodes, arcs, ends.filter((id) => nodes.has(id)),
    fwd[1], ends.length === 0 && (fwd[2] || chosen[2]) || pruned]
}
type PersistenceFact = Extract<IndexBodyFact, { kind: 'persistence' }>
function endFacts(
  i: ReadyQueryIndex, arc: Arc, options: readonly PersistenceFact[],
): PersistenceFact[] {
  if (arc[2] !== 'channel') return [...options]
  const pub = arc[3][0]!, position = pub[7]
  if (position === undefined) return []
  const call = i.operation_by_id.get(arc[4][0]!)
  if (call?.kind !== 'call') return []
  const transport = i.channels_by_id.get(pub[2])!.transport,
    matches = (i.operations_by_owner.get(arc[1]) ?? []).flatMap((cond) => {
    if (cond.kind !== 'condition' || cond.condition_kind !== 'switch'
      || cond.test?.kind !== 'template') return []
    const [parameter, ...rawPath] = cond.test.parts
    if (parameter?.kind !== 'parameter' || parameter.position !== 0
      || rawPath.some((part) => part.kind !== 'literal'
        || typeof part.value !== 'string')) return []
    const path = rawPath.map((part) => (part as Extract<IndexValue, {
      kind: 'literal'
    }>).value as string)
    if (transport === 'bullmq' && path[0] === 'data') path.shift()
    let value: IndexValue | undefined = call.arguments[position]
    for (const key of path) value = value?.kind === 'object'
      ? value.entries.find((entry) => entry.key === key)?.value : undefined
    if (value?.kind !== 'literal') return []
    const arm = `case:${Buffer.from(JSON.stringify([
      typeof value.value, value.value,
    ])).toString('base64url')}`
    const eligible = options.filter((fact) => fact.control.some((frame) =>
      frame.kind === 'branch' && frame.controller_fact_id === cond.id
      && frame.arm === arm))
    return eligible.length > 0 ? [eligible] : []
  })
  return matches.length === 1 ? matches[0]! : []
}
function controls(
  i: ReadyQueryIndex, arcs: readonly Arc[], ends: readonly string[],
  seeds: readonly string[],
): Control {
  const ops = i.operation_by_id
  const factIds = [...new Set(arcs.flatMap((arc) => arc[4]))],
    core = new Set([...seeds, ...factIds])
  const endOps = new Set<string>()
  for (const id of ends) {
    const options = (i.operations_by_owner.get(id) ?? []).filter(terminal),
      incoming = arcs.filter((arc) => arc[1] === id && arc[2] === 'channel'),
      groups = incoming.length > 0
        ? incoming.map((arc) => endFacts(i, arc, options)) : [options],
      chosen = groups.map((group) => group.filter((entry) =>
        !bad(entry)
        && !bad(ops.get(entry.call_fact_id))).at(-1))
    if (chosen.some((fact) => !fact)) continue
    for (const fact of chosen as PersistenceFact[]) {
      core.add(fact.id); endOps.add(fact.id)
    }
  }
  type Group = [kind: 'branch' | 'loop' | 'parallel', controller: string,
    arm: string | undefined, ops: Set<string>, nodes: Set<string>]
  const groupsBy = new Map<string, Group>(),
    seqs = new Map<string, Extract<IndexBodyFact, { kind: 'call' }>[]>()
  const need = new Set(core)
  let proven = true
  for (const id of need) {
    const fact = ops.get(id)
    if (!fact) { proven = false; continue }
    if (factIds.includes(id) && fact.kind === 'call'
      && !fact.control.some((frame) => frame.kind === 'parallel')) {
      append(seqs, `${fact.owner_symbol_id}\0${JSON.stringify(fact.control)}`, fact)
    }
    for (const frame of fact.control) {
      if (frame.kind === 'exception') continue
      need.add(frame.controller_fact_id)
      const arm = frame.kind === 'branch' ? frame.arm : undefined
      const key = `${frame.kind}\0${frame.controller_fact_id}\0${arm ?? ''}`
      const group = groupsBy.get(key)
        ?? [frame.kind, frame.controller_fact_id, arm, new Set(), new Set()] as Group
      groupsBy.set(key, group)
      group[3].add(fact.id); group[4].add(fact.owner_symbol_id)
    }
    if (fact.kind === 'parallel') {
      fact.member_fact_ids.forEach((member) => need.add(member))
    }
    if (fact.kind === 'persistence') need.add(fact.call_fact_id)
  }
  const ordered: WorkflowControlGroup[] = []
  for (const calls of seqs.values()) if (calls.length > 1) {
    calls.sort((a, b) => orderBy(a.order, b.order) || cmp(a.id, b.id))
    ordered.push({ kind: 'sequence',
      operationIds: calls.map((fact) => fact.id),
      symbolIds: calls.flatMap((fact) => fact.target_symbol_id ? [fact.target_symbol_id] : []) })
  }
  const groups = [...groupsBy.values()]
    .map<WorkflowControlGroup>(([
      kind, controllerOperationId, arm, ops, nodes,
    ]) => ({
      kind, controllerOperationId, ...(arm ? { arm } : {}),
      operationIds: [...ops].sort(cmp), symbolIds: [...nodes].sort(cmp),
    })).concat(ordered)
  return [[...need].sort(cmp), groups, proven, [...endOps].sort(cmp)]
}
function cycles(nodes: ReadonlySet<string>, arcs: readonly Arc[]): WorkflowControlGroup[] {
  const walks = new Map([...nodes].map((id) => [id, new Set<string>()]))
  for (const arc of arcs) walks.get(arc[0])?.add(arc[1])
  for (const through of nodes) for (const from of nodes) {
    if (!walks.get(from)?.has(through)) continue
    for (const to of walks.get(through) ?? []) walks.get(from)!.add(to)
  }
  const groups: WorkflowControlGroup[] = []
  for (const symbol of nodes) {
    const members = [...nodes].filter((cand) =>
      walks.get(symbol)?.has(cand) && walks.get(cand)?.has(symbol)).sort(cmp)
    if (members[0] !== symbol) continue
    groups.push({ kind: 'cycle', operationIds: [], symbolIds: members })
  }
  return groups
}
function pickIds(
  v: ExecutionView, ids: readonly string[], target: string,
  role: 'subject' | 'exact' | 'names' | 'entry' | 'stage' | 'behavior' | 'terminal',
): string[] {
  const lexical = words(target), names = role === 'names',
    tokens = (id: string) => v[1].get(id)![names ? 4 : 3] as ReadonlySet<string>,
    full = (id: string) => v[1].get(id)![names ? 2 : 1]
      .includes(lexical.join('')) || lexical.every((term) => tokens(id).has(term))
  if (role === 'entry' && lexical.includes('request')) {
    const entries = ids.filter((id) => v[1].get(id)![8]),
      rest = lexical.filter((token) => token !== 'request')
    return rest.length === 0 ? entries : entries.filter((id) =>
      rest.every((token) => v[1].get(id)![3].has(token)))
  }
  if (role !== 'terminal') {
    const exact = ids.filter(full)
    if (exact.length > 0 || role === 'exact' || names) return exact
    const related = ids.filter((id) =>
      lexical.some((term) => tokens(id).has(term)))
    return lexical.every((term) => related.some((id) => tokens(id).has(term)))
      ? related : []
  }
  const specific = lexical.filter((token) => !GENERIC_TERMINAL.test(token))
  if (specific.length === 0) return [...ids]
  const exact = ids.filter(full)
  if (exact.length > 0) return exact
  return ids.filter((id) => specific.every((token) => {
    const lexicon = v[1].get(id)![3]
    return lexicon.has(token) || /^(?:database|db)$/u.test(token)
      && [...lexicon].some((cand) => DATABASE.test(cand))
  }))
}
function channelFit(
  i: ReadyQueryIndex, id: string, target: string,
): boolean {
  const channel = i.channels_by_id.get(id)
  if (!channel) return false
  const expected = words(target), key = words(channel.key),
    actual = words(`${channel.channel_kind} ${channel.transport}`).concat(key),
    compact = expected.join(''), suffix = key.join(''),
    forms = `${suffix}\0${actual[0]}${actual[1]}${suffix}\0${
      actual[1]}${actual[0]}${suffix}`
  return expected.every((token) => actual.includes(token))
    || forms.includes(compact)
}
function stageMatch(
  i: ReadyQueryIndex, v: ExecutionView, selection: Selection, target: string,
  omitted: readonly string[],
): readonly [string[], Arc[]] {
  const nodes = pickIds(v, [...selection[0]].filter((id) =>
    !omitted.includes(id)), target, 'stage')
  if (nodes.length > 0) return [nodes, []]
  const arcs = selection[1].filter((arc) =>
    arc[3].some((edge) =>
      channelFit(i, edge[1], target) || channelFit(i, edge[2], target)))
  return [[...new Set(arcs.flatMap((arc) => [arc[0], arc[1]]))].sort(cmp), arcs]
}
function scanRoots(
  v: ExecutionView,
  ranks: readonly Candidate[],
  goals: readonly string[],
): readonly [ids: string[], actual: Set<string>, bounded: boolean] {
  const traversal = reach(
    v, ranks.map((entry) => entry[0][0]), true, RECOVERY,
  )
  const rank = (id: string): number => {
    const symbol = v[1].get(id)!
    return rootRank(v, symbol, score(symbol, goals))
  }
  const ids = [...traversal[0].keys()].filter((id) =>
    !v[5].has(id)
    && !v[1].get(id)?.[6])
    .sort((left, right) =>
      penalty(v[1].get(left)![7]) - penalty(v[1].get(right)![7])
        || rank(right) - rank(left)
        || (v[2].get(right)?.length ?? 0) - (v[2].get(left)?.length ?? 0)
        || cmp(left, right))
  return [ids, traversal[1], traversal[2]]
}
export function selectWorkflow(i: ReadyQueryIndex, plan: QueryPlan): WorkflowSelection {
  const v = buildView(i), ops = i.operation_by_id,
    { intent, subject: target, terms, obligations, access } = plan,
    isFlow = intent === 'workflow',
    bound = (kind: ObligationKind): string | undefined =>
      obligations.find((entry) => entry.kind === kind
        && entry.target !== target)?.target,
    goals = [...new Set([
      target, ...terms, ...obligations.map((entry) => entry.target),
    ])],
    lastBound = bound('terminal'),
    stageNeed = bound('stage'),
    behaviorNeed = bound('behavior'),
    asyncNeed = words(bound('handoff') ?? '').some((word) =>
      /^(?:async|dispatch|emit|enqueue|event|job|publish|queue|schedule)$/u.test(word)),
    fail = goals.some((entry) =>
      words(entry).some((word) => FAILURE_WORD.test(word)))
  const cand = (symbol: SymbolNode): Candidate => {
    const lexical = score(symbol, goals),
      outgoing = v[2].get(symbol[0]) ?? [],
      affinity = isFlow
        ? outgoing.some((arc) => arc[2] === 'channel') ? 2
          : Number(outgoing.some((arc) => arc[2] === 'direct'
            && v[2].get(arc[1])?.some((next) => next[2] === 'channel')))
        : intent === 'explain'
          ? Number(v[2].has(symbol[0]) || v[3].has(symbol[0]))
            + Number(symbol[5].some((fact) =>
              ['condition', 'loop', 'parallel'].includes(fact.kind)))
        : intent !== 'locate' || !access ? 0
          : access === 'write' ? Number(symbol[6]
            || symbol[5].some((fact) => fact.kind === 'mutation'))
            : Number(symbol[5].some((fact) => fact.kind === 'persistence'
              && READ.test(fact.operation))),
      exact = isFlow ? Number(!v[5].has(symbol[0]))
        : Number(pickIds(v, [symbol[0]], target, 'names').length > 0)
    return [symbol, lexical, rootRank(v, symbol, lexical), affinity, exact]
  }
  const ranks = v[0].map(cand)
    .filter((entry) => entry[1] > 0 && (!isFlow
      || v[2].has(entry[0][0]) || v[3].has(entry[0][0])
      || v[4].has(entry[0][0])))
    .sort((a, b) => isFlow
      ? b[4] - a[4] || b[3] - a[3] || b[2] - a[2]
        || cmp(a[0][0], b[0][0])
      : intent === 'locate'
        ? b[3] - a[3] || b[4] - a[4]
          || penalty(a[0][7]) - penalty(b[0][7])
          || b[1] - a[1] || cmp(a[0][0], b[0][0])
        : b[4] - a[4] || b[2] - a[2]
          || b[3] - a[3] || b[1] - a[1] || cmp(a[0][0], b[0][0]))
    .slice(0, CANDIDATES),
    focus = ranks[0]?.[0][0]
  const entryNeed = bound('entry'),
    entryPool = isFlow ? ranks.filter((entry) => !v[5].has(entry[0][0])) : [],
    entryIds = entryNeed
      ? new Set(pickIds(v, entryPool.map((entry) => entry[0][0]),
        entryNeed, 'entry')) : undefined
  let entries = entryPool.filter((entry) =>
    !entryIds || entryIds.has(entry[0][0])).slice(0, 3)
  let scan: ReturnType<typeof scanRoots> | undefined
  if (isFlow && ranks.length > 0 && (entries.length === 0
    || entries.every((entry) => entry[0][7] !== 'production'))) {
    scan = scanRoots(v, ranks, goals)
    const eligible = entryNeed
      ? new Set(pickIds(v, scan[0], entryNeed, 'entry')) : undefined
    const recovered = scan[0].filter((id) => !eligible || eligible.has(id))
      .map((id) => cand(v[1].get(id)!))
    entries = [...new Map([...recovered, ...entries].map((entry) =>
      [entry[0][0], entry])).values()].slice(0, 3)
  }
  let roots: string[] = []
  const subjectTerms = new Set(words(target)),
    callTarget = terms.filter((term) => !subjectTerms.has(term)).join(' '),
    direct = focus && intent === 'explain'
      ? (v[2].get(focus) ?? []).filter((arc) => arc[2] === 'direct') : [],
    wanted = callTarget ? direct.find((arc) =>
      pickIds(v, [arc[1]], callTarget, 'names').length > 0) : undefined,
    callArcs = direct.filter((arc) =>
      arc === wanted || score(v[1].get(arc[1])!, goals) > 0)
      .sort((a, b) => Number(b === wanted) - Number(a === wanted)
        || score(v[1].get(b[1])!, goals) - score(v[1].get(a[1])!, goals)
        || cmp(a[1], b[1])).slice(0, 3),
    ids = focus ? [focus, ...callArcs.map((arc) => arc[1])] : []
  let flow: Selection = isFlow ? [new Set(), [], [], new Set(), false]
    : [new Set(ids), callArcs, [], new Set(ids), false]
  const seen = new Set<string>()
  let tries = isFlow ? 0 : focus ? 1 : 0
  let locked = false, bestStage = !stageNeed
  for (const entry of entries) {
    const id = entry[0][0]
    const room = NODES - RECOVERY - seen.size
    if (room <= 0) break
    const trial = corridor(v, id, room, goals, fail, lastBound, asyncNeed)
    trial[3].forEach((cand) => seen.add(cand))
    tries += 1
    const stageFit = (!stageNeed
      || stageMatch(i, v, trial, stageNeed, [id])[0].length > 0)
      && (!asyncNeed || trial[1].some((arc) => arc[2] === 'channel'))
    const domain = penalty(entry[0][7]), prior = roots[0]
      ? penalty(v[1].get(roots[0])![7]) : Infinity
    if (entryNeed && domain === prior && roots.length > 0 && [...trial[0]].some((node) =>
      node !== id && flow[0].has(node))) {
      const merged = [...new Set([...flow[1], ...trial[1]])]
      if (new Set(merged.flatMap(idsOf)).size > HOPS) {
        flow = [flow[0], flow[1], flow[2], flow[3], true]
      } else {
        flow = [new Set([...flow[0], ...trial[0]]), merged,
          [...new Set([...flow[2], ...trial[2]])],
          new Set([...flow[3], ...trial[3]]), flow[4] || trial[4]]
        roots.push(id)
      }
      continue
    }
    if (roots.length === 0 || !locked
      && (domain < prior || domain === prior
      && (Number(stageFit) > Number(bestStage)
      || stageFit === bestStage
      && (Number(trial[2].length > 0) > Number(flow[2].length > 0)
        || Boolean(trial[2].length) === Boolean(flow[2].length)
          && flow[4] && !trial[4])))) {
      roots = [id]
      flow = trial
      bestStage = stageFit
      locked = !lastBound && !stageNeed && !asyncNeed && trial[2].length === 0
        && pickIds(v, [id], target, 'names').length > 0
        && (trial[1].length > 0 || v[4].has(id))
    }
  }

  // Pass two is a bounded, shared rec frontier. Alternates are admitted
  // only when they are structural entries; disconnected middle-stage matches
  // can never manufacture an entry-to-persistence corridor.
  const rec = new Set<string>()
  scan?.[1].forEach((id) => rec.add(id))
  flow[3].forEach((id) => seen.add(id))
  let bounded = flow[4]
  let passes: 0 | 1 | 2 = scan ? 1 : 0
  if (isFlow && (flow[2].length === 0 || flow[4])
    && ranks.length > 0) {
    scan ??= scanRoots(v, ranks, goals)
    scan[1].forEach((id) => { rec.add(id); seen.add(id) })
    bounded ||= scan[2]
    passes = 1
    const eligible = entryNeed
      ? new Set(pickIds(v, scan[0], entryNeed, 'entry')) : undefined
    const alternates = flow[2].length === 0 && !locked
      ? scan[0].filter((id) => id !== roots[0]
        && (!eligible || eligible.has(id))).slice(0, 3 - tries) : []
    if (alternates.length > 0) passes = 2
    for (const id of alternates) {
      tries += 1
      const room = RECOVERY - rec.size + 1
      if (room <= 0) { bounded = true; break }
      const trial = corridor(v, id, room, goals, fail, lastBound, asyncNeed)
      bounded ||= trial[4]
      trial[3].forEach((entry) => { rec.add(entry); seen.add(entry) })
      if (roots[0] && v[4].has(roots[0])
        && pickIds(v, [roots[0]], target, 'names').length > 0) continue
      roots = [id]; flow = trial; break
    }
  } else if (intent === 'explain' && focus
    && !(v[1].get(focus)?.[5].some(behavior) ?? false)) {
    const alternate = ranks.slice(1, 4).find((entry) =>
      entry[0][5].some(behavior))
    if (alternate) {
      passes = 1
      tries += 1
      const id = alternate[0][0]
      rec.add(id); seen.add(id)
      flow = [new Set([id]), [], [], new Set([id]), false]
    }
  }
  const [nodes, links, ends] = flow
  const rootIds = isFlow
    ? roots.filter((id) => nodes.has(id)).sort(cmp)
    : callArcs.length > 0 && focus ? [focus] : []
  const causal = [...new Set([
    ...rootIds, ...ends, ...links.flatMap((arc) => [arc[0], arc[1]]),
  ])].sort(cmp)
  const symbolIds = [...nodes].sort(cmp),
    edges = [...new Map(links.flatMap((arc) =>
      arc[3].map((edge) => [edge[0], edge] as const))).values()]
      .map(([id, fromId, toId, relation]) =>
      ({ id, fromId, toId, relation })).sort((a, b) => cmp(a.id, b.id)),
    subjects = pickIds(v, symbolIds, target,
      intent === 'locate' && !access ? 'names' : 'subject'),
    behaviors = isFlow ? causal : subjects,
    owners = new Set(links.flatMap((arc) => [arc[0], arc[1]]))
  const seeds = intent === 'locate' ? [] : behaviors
    .filter((id) => !owners.has(id) && !ends.includes(id))
    .flatMap((id) => {
    const facts = v[1].get(id)?.[5].filter((fact) =>
      behavior(fact) && (fail || !bad(fact))) ?? []
    return [...new Map(facts.map((fact) => [fact.kind, fact.id])).values()]
  })
  const locateOps = intent === 'locate' && access
    ? subjects.flatMap((id) => {
      const expected = words(target)
      return (v[1].get(id)?.[5] ?? [])
        .filter((fact) => {
          const compatible = fact.kind === 'persistence'
            ? (access === 'read')
              === READ.test(fact.operation)
            : access === 'write' && fact.kind === 'mutation'
          const actual = new Set(words(factText(fact)))
          return compatible && expected.length > 0
            && expected.every((word) => actual.has(word))
        })
        .map((fact) => fact.id)
    })
    : []
  const ctl: Control = intent === 'locate'
    ? locateOps.length > 0 ? controls(i, [], [], locateOps) : [[], [], true, []]
    : controls(i, links, ends, seeds)
  const steps = isFlow ? causal : symbolIds,
    edgeIds = edges.map((edge) => edge.id),
    chosenOps = new Set(ctl[0]),
    terminalIds = [...new Set(ctl[3].map((id) =>
      ops.get(id)?.owner_symbol_id).filter(
      (id): id is string => id !== undefined,
    ))].sort(cmp),
    arcOps = [...new Set(links.flatMap((arc) => arc[4]))]
      .filter((id) => chosenOps.has(id))
  const related = (ids: readonly string[], calls = false): string[] =>
    ctl[0].filter((id) => {
    const fact = ops.get(id)
    return !!fact && (ids.includes(fact.owner_symbol_id) || calls
      && fact.kind === 'call' && !!fact.target_symbol_id
        && ids.includes(fact.target_symbol_id))
  })
  const stage = stageNeed
      ? stageMatch(i, v, flow, stageNeed, rootIds)
      : undefined,
    stageNodes = stage?.[0] ?? steps,
    stageOps = stage ? stage[1].length > 0
      ? [...new Set(stage[1].flatMap((arc) => arc[4]))]
        .filter((id) => chosenOps.has(id)).sort(cmp)
      : related(stageNodes, true) : ctl[0],
    stageEdges = stage ? [...new Set(stage[1].flatMap(idsOf))].sort(cmp) : edgeIds,
    behaviorIds = behaviorNeed
      ? pickIds(v, [...flow[0]], behaviorNeed, 'behavior') : behaviors,
    allBehavior = related(behaviors),
    behaviorOps = behaviorNeed ? related(behaviorIds, true) : allBehavior
  const inert = behaviors.filter((id) => !owners.has(id)
    && !allBehavior.some((operation) =>
    ops.get(operation)?.owner_symbol_id === id))
  const gaps = causal.filter((id) => v[4].has(id))
  type ProofData = readonly [
    nodes: readonly string[], ops: readonly string[], proven: boolean,
  ]
  const data: Record<ObligationKind, ProofData> = {
    subject: [subjects, intent === 'locate' && access ? locateOps : related(subjects),
      subjects.length > 0 && (!access || locateOps.length > 0)],
    entry: [rootIds, related(rootIds), rootIds.length > 0
      && (!entryIds || rootIds.some((id) => entryIds.has(id)))],
    stage: [stageNodes, stageOps,
      steps.length > 0 && (!stageNeed || stageNodes.length > 0)],
    handoff: [causal, isFlow ? arcOps : related(causal),
      links.length > 0 && (!isFlow || gaps.length === 0)
      && (!asyncNeed || links.some((arc) => arc[2] === 'channel'))],
    behavior: [behaviorIds, behaviorOps,
      behaviors.length > 0 && inert.length === 0
      && (!behaviorNeed || behaviorIds.length > 0)],
    ordering: [steps, arcOps,
      links.length > 0 && gaps.length === 0 && ctl[2]
      && links.every((arc) => arc[4].length > 0)],
    terminal: [terminalIds, ctl[3], terminalIds.length > 0],
  }
  const missing: WorkflowMissingReason[] = []
  const proofs = obligations.map((obligation): WorkflowObligationProof => {
    const [symbolIds, operationIds, proven] = data[obligation.kind],
      proofEdges = obligation.kind === 'stage' ? stageEdges
        : /^(?:handoff|behavior|ordering)$/u.test(obligation.kind) ? edgeIds : []
    const proof = {
      ...obligation, proven, symbolIds, operationIds, edgeIds: proofEdges,
    }
    if (proof.mandatory && !proof.proven) {
      missing.push({ code: MISSING_CODES[proof.kind] ?? 'obligation_target_unproven',
        target: proof.kind === 'handoff' && gaps.length > 0
          ? gaps.join(',') : proof.target,
        obligationId: proof.id })
    }
    return proof
  })
  if (!ctl[2]) missing.push({ code: 'controller_dependency_unproven', target })
  if (bounded) missing.push({ code: 'selection_bound_reached', target })
  return {
    complete: missing.length === 0,
    symbolIds,
    operationIds: ctl[0],
    rootSymbolIds: rootIds,
    terminalSymbolIds: terminalIds,
    edges,
    links: links.map((arc) => ({
      fromId: arc[0], toId: arc[1], kind: arc[2],
      edgeIds: idsOf(arc),
      operationIds: arc[4].filter((id) =>
        chosenOps.has(id) && ops.get(id)?.owner_symbol_id === arc[0]),
    })),
    controlGroups: [...ctl[1], ...cycles(new Set(causal), links)],
    obligations: proofs,
    missing,
    metrics: {
      candidateCount: ranks.length, rootCandidateCount: tries,
      actualNodeCount: seen.size,
      causalRelationHops: edges.length, recoveryPasses: passes,
      recoveryFrontierCount: rec.size, bounded,
    },
  }
}
