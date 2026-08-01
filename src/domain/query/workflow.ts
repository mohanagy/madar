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
  READ = /^(?:read|file_read|object_read)$/u
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
  range: string, statement: string, owner: string, operation: string,
  dispatchPayload: number | undefined,
]
type Arc = readonly [
  from: string, to: string, kind: 'direct' | 'channel',
  edges: readonly IndexedEdge[], operations: readonly string[],
]
type ExecutionView = readonly [
  symbols: readonly SymbolNode[], byId: ReadonlyMap<string, SymbolNode>,
  outgoing: ReadonlyMap<string, readonly Arc[]>,
  incoming: ReadonlyMap<string, readonly Arc[]>, blocked: ReadonlySet<string>,
  nonEntries: ReadonlySet<string>, operations: ReadonlyMap<string, IndexBodyFact>,
]
type Candidate = readonly [
  symbol: SymbolNode, lexical: number, rank: number,
  affinity: number, exact: number,
]
type Reach = readonly [
  distance: Map<string, number>, actual: Set<string>, bounded: boolean,
  previous: Map<string, Arc>,
]
type Selection = readonly [
  symbols: Set<string>, arcs: Arc[], terminals: string[],
  actual: Set<string>, bounded: boolean,
]
type Control = readonly [
  operations: string[], groups: WorkflowControlGroup[], proven: boolean,
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
          : fact.kind === 'condition' ? `condition ${fact.condition_kind}`
            : fact.kind === 'loop' ? `loop ${fact.loop_kind}`
              : fact.kind === 'parallel'
                ? `parallel ${fact.combinator} ${fact.completion}`
                : fact.kind
const behavior = (fact: IndexBodyFact): boolean => fact.kind !== 'literal'
const terminal = (
  fact: IndexBodyFact,
): fact is Extract<IndexBodyFact, { kind: 'persistence' }> =>
  fact.kind === 'persistence' && !READ.test(fact.operation)
function adverseFact(fact: IndexBodyFact | undefined): boolean {
  return !!fact && (fact.control.some((frame) =>
    frame.kind === 'exception' && frame.arm === 'catch')
    || fact.kind === 'call'
    && fact.arguments.some((argument) =>
        valueHas(argument, (value) => value.kind === 'literal'
          && typeof value.value === 'string'
          && words(value.value).some((word) =>
            word !== 'retry' && FAILURE_WORD.test(word)))))
}
const terminalAt = (v: ExecutionView, id: string, adverse: boolean): boolean =>
  v[1].get(id)?.[5].some((fact) => terminal(fact)
    && (adverse || !adverseFact(fact) && !adverseFact(v[6].get(fact.call_fact_id)))) ?? false
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
function requestEntry(attrs: GraphAttributes): boolean {
  const role = text(attrs, 'framework_role'),
    kind = text(attrs, 'node_kind')
  return kind === 'route'
    || /(?:_route|_api|_server_action|router_(?:loader|action)|trpc_procedure_)/u
      .test(role)
}
function buildView(i: ReadyQueryIndex): ExecutionView {
  const prior = cache.get(i)
  if (prior) return prior
  const symbols: SymbolNode[] = []
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
    symbols.push([id, lexicon.join(''), nameWords.join(''),
      new Set(lexicon), new Set(nameWords), facts, facts.some(terminal),
      domainOf(attrs.source_domain, file, i.root_path), requestEntry(attrs)])
  }
  symbols.sort((left, right) => cmp(left[0], right[0]))
  const byId = new Map(symbols.map((symbol) => [symbol[0], symbol])),
    exact = new Map<string, IndexedEdge>(),
    routes = new Map<string, IndexedEdge[]>(),
    consumers = new Map<string, IndexedEdge[]>(), publishes: IndexedEdge[] = [],
    nonEntries = new Set<string>()
  const keep = (key: string, edge: IndexedEdge): void => {
    const prior = exact.get(key)
    if (!prior || cmp(edge[0], prior[0]) < 0) exact.set(key, edge)
  }
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
      calls = relation === 'consumed_by' && owner && owner !== to
        ? (i.operations_by_owner.get(owner) ?? []).filter((fact) =>
          fact.kind === 'call'
          && rangeKey(fact.evidence.statement_range)
            === rangeKey(evidence?.statement_range)
          && fact.evidence.excerpt_sha256 === evidence?.excerpt_sha256)
        : [],
      payload = attrs.dispatch_payload_argument,
      edge: IndexedEdge = [id, from, to, relation,
        rangeKey(evidence?.range), rangeKey(evidence?.statement_range),
        owner, calls.length === 1 ? calls[0]!.id : '',
        typeof payload === 'number' && Number.isSafeInteger(payload) && payload >= 0
          ? payload : undefined]
    if (byId.has(to) && (relation === 'consumed_by'
      || relation === 'calls' && byId.get(from)?.[7] === 'production')) nonEntries.add(to)
    if (relation === 'calls') keep(`c\0${from}\0${to}\0${edge[4]}`, edge)
    else if (relation === 'routes_through') append(routes, `${from}\0${to}`, edge)
    else if (relation === 'consumed_by') append(consumers, from, edge)
    else publishes.push(edge)
  }
  publishes.sort((a, b) => cmp(a[0], b[0]))
  for (const entries of consumers.values()) entries.sort((a, b) => cmp(a[0], b[0]))
  const arcs: Arc[] = [],
    publishCalls = new Map<string, Extract<IndexBodyFact, { kind: 'call' }> []>()
  for (const owner of symbols) {
    for (const fact of owner[5]) {
      if (fact.kind !== 'call' || !fact.target_symbol_id
        || !byId.has(fact.target_symbol_id)) continue
      append(publishCalls, `${owner[0]}\0${rangeKey(fact.evidence.range)}\0${
        rangeKey(fact.evidence.statement_range)}`, fact)
      const edge = exact.get(
        `c\0${owner[0]}\0${fact.target_symbol_id}\0${rangeKey(fact.evidence.range)}`,
      )
      if (edge) arcs.push([owner[0], fact.target_symbol_id, 'direct', [edge], [fact.id]])
    }
  }
  for (const publish of publishes) {
    if (!byId.has(publish[1]) || !i.channels_by_id.has(publish[2])) continue
    const channel = i.channels_by_id.get(publish[2])!,
      matchingRoutes = channel.channel_kind === 'job'
        ? (routes.get(`${channel.id}\0${channel.parent_channel_id}`) ?? [])
          .filter((edge) => edge[6] === publish[1]
            && edge[4] === publish[4] && edge[5] === publish[5])
        : [],
      route = matchingRoutes.length === 1 ? matchingRoutes[0] : undefined
    if (channel.channel_kind === 'job' && !route) continue
    const destination = route?.[2] ?? channel.id
    for (const consume of consumers.get(destination) ?? []) {
      if (!byId.has(consume[2])) continue
      const registration = !consume[6] || consume[6] === consume[2]
        ? [] : consume[7] ? [consume[7]] : undefined
      if (!registration) continue
      const edges = route ? [publish, route, consume] : [publish, consume],
        calls = publishCalls.get(
          `${publish[1]}\0${publish[4]}\0${publish[5]}`,
        ) ?? []
      arcs.push([publish[1], consume[2], 'channel', edges,
        calls.length === 1 ? [calls[0]!.id, ...registration] : []])
    }
  }
  arcs.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1])
    || cmp(a[3][0]![0], b[3][0]![0]))
  const outgoing = new Map<string, Arc[]>(), incoming = new Map<string, Arc[]>()
  for (const arc of arcs) {
    append(outgoing, arc[0], arc); append(incoming, arc[1], arc)
  }
  const usedEdges = new Set(arcs.flatMap(idsOf)),
    blocked = new Set(publishes.filter((edge) => byId.has(edge[1])
      && !usedEdges.has(edge[0])).map((edge) => edge[1])),
    v: ExecutionView = [
      symbols, byId, outgoing, incoming, blocked, nonEntries, i.operation_by_id,
    ]
  cache.set(i, v)
  return v
}
function score(symbol: SymbolNode, targets: readonly string[]): number {
  let result = 0
  for (const target of targets) {
    const terms = words(target), compact = terms.join('')
    if (compact && symbol[2].includes(compact)) result += 128
    if (terms.length > 0 && terms.every((term) => symbol[4].has(term))) result += 64
    if (compact && symbol[1].includes(compact)) result += 32
    for (const term of terms) {
      if (symbol[3].has(term)) result += 8
      if (symbol[4].has(term)) result += 8
    }
  }
  return result
}
function rootScore(v: ExecutionView, symbol: SymbolNode, lexical: number): number {
  const degree = (v[3].get(symbol[0])?.length ?? 0)
      + (v[2].get(symbol[0])?.length ?? 0)
      + (v[4].has(symbol[0]) ? 1 : 0),
    unresolved = symbol[5].filter((fact) => fact.kind === 'call'
      && !fact.target_symbol_id).length
  return lexical - penalty(symbol[7]) - Math.min(24, Math.max(0, degree - 8) * 2)
    - Math.min(16, unresolved * 4)
    - (degree === 0 && !symbol[6] ? 12 : 0)
    - (symbol[6] ? 16 : 0)
}
function adverseArc(v: ExecutionView, arc: Arc): boolean {
  return arc[4].some((id) => {
    const fact = v[6].get(id)
    if (adverseFact(fact)) return true
    if (arc[2] !== 'channel' || fact?.kind !== 'call' || !fact.target_symbol_id) {
      return false
    }
    const matching = (v[2].get(fact.target_symbol_id) ?? []).filter((inner) =>
      inner[2] === 'channel' && inner[1] === arc[1])
    return matching.length > 0 && matching.every((inner) =>
      inner[4].some((operation) => adverseFact(v[6].get(operation))))
  })
}
function reach(
  v: ExecutionView, seeds: readonly string[], reverse: boolean,
  limit: number, accept?: (arc: Arc) => boolean,
  allowed?: { has(id: string): boolean }, stops?: ReadonlySet<string>,
): Reach {
  const distance = new Map(seeds.map((seed) => [seed, 0]))
  const actual = new Set(seeds), queue = [...seeds]
  const previous = new Map<string, Arc>(), overflow = new Set<string>()
  let bounded = false
  while (queue.length > 0) {
    queue.sort((left, right) => distance.get(left)! - distance.get(right)!
      || cmp(left, right))
    const current = queue.shift()!
    if (stops?.has(current)) continue
    const base = distance.get(current)!,
      arcs = (reverse ? v[3] : v[2]).get(current) ?? []
    for (const arc of arcs) {
      if (accept && !accept(arc)) continue
      const next = reverse ? arc[0] : arc[1], hops = base + arc[3].length
      if (hops > HOPS) { overflow.add(next); continue }
      if ((allowed && !allowed.has(next)) || (distance.get(next) ?? Infinity) <= hops) continue
      const additions = [...new Set(arc[3].flatMap((edge) => [edge[1], edge[2]]))]
        .filter((id) => !actual.has(id))
      if (actual.size + additions.length > limit) { bounded = true; continue }
      additions.forEach((id) => actual.add(id))
      distance.set(next, hops)
      previous.set(next, arc)
      if (!queue.includes(next)) queue.push(next)
    }
  }
  return [
    distance, actual, bounded || [...overflow].some((id) => !distance.has(id)),
    previous,
  ]
}
function bestPath(
  v: ExecutionView, root: string, end: string,
  allowed: ReadonlySet<string>, targets: readonly string[],
  accept?: (arc: Arc) => boolean,
): readonly [path: Arc[], bounded: boolean] {
  let best: Arc[] = [], bestRank = -1, bestHops = 0,
    count = 0, bounded = false
  const visit = (
    at: string, path: Arc[], seen: Set<string>, hops: number, rank: number,
  ): void => {
    if (count++ >= NODES) { bounded = true; return }
    if (at === end) {
      if (rank > bestRank || rank === bestRank && hops > bestHops) {
        best = path; bestRank = rank; bestHops = hops
      }
      return
    }
    for (const arc of v[2].get(at) ?? []) {
      if (bounded) break
      const next = arc[1], nextHops = hops + arc[3].length
      if (!allowed.has(next) || seen.has(next) || nextHops > HOPS
        || accept && !accept(arc)) continue
      seen.add(next)
      visit(next, [...path, arc], seen, nextHops,
        rank + score(v[1].get(next)!, targets))
      seen.delete(next)
    }
  }
  visit(root, [], new Set([root]), 0, 0)
  return [best, bounded || bestRank < 0]
}
function orderCmp(
  left: readonly number[], right: readonly number[],
): number {
  let i = 0
  while (i < left.length && i < right.length && left[i] === right[i]) i += 1
  return (left[i] ?? 0) - (right[i] ?? 0) || left.length - right.length
}
function corridor(
  v: ExecutionView, root: string, limit: number, targets: readonly string[],
  terminalTarget?: string,
): Selection {
  const failureIntent = targets.some((target) =>
      words(target).some((word) => FAILURE_WORD.test(word))),
    accept = failureIntent ? undefined : (arc: Arc) => !adverseArc(v, arc),
    forward = reach(v, [root], false, limit, accept)
  const found = [...forward[0].keys()].filter((id) =>
      terminalAt(v, id, failureIntent)),
    requested = terminalTarget
      ? targetSymbols(v, found, terminalTarget, 'terminal') : [],
    candidates = terminalTarget ? requested : found
  const structural = new Set(candidates.filter((id) =>
      v[3].get(id)?.some((arc) => arc[2] === 'channel'))),
    relevant = candidates.filter((id) => score(v[1].get(id)!, targets) > 0),
    scoped = new Set(structural),
    stable = reach(v, [root], false, limit, (arc) =>
      (!accept || accept(arc)) && !arc[4].some((id) =>
        v[6].get(id)?.control.some((frame) =>
          frame.kind === 'branch' || frame.kind === 'loop')))[0]
  const direct = (arc: Arc) =>
    arc[2] === 'direct' && (!accept || accept(arc)) && forward[0].has(arc[1])
  for (const seed of structural) {
    const first = (v[2].get(seed) ?? []).filter(direct),
      hits = new Map<string, [number, boolean]>()
    let branches = 0
    for (const id of new Set(first.map((arc) => arc[1]))) {
      const below = reach(
          v, [id], false, limit, direct, forward[0],
        )[0],
        reached = [...below.keys()].filter((candidate) => candidates.includes(candidate))
      if (!reached.some((candidate) => candidate !== seed)) continue
      const unconditional = first.some((arc) => arc[1] === id
        && arc[4].some((operation) => {
        const fact = v[1].get(seed)?.[5].find((entry) => entry.id === operation)
        return fact?.kind === 'call' && !fact.control.some((frame) =>
          frame.kind === 'branch' || frame.kind === 'loop')
      }))
      branches += 1
      for (const candidate of reached) {
        const prior = hits.get(candidate) ?? [0, false]
        hits.set(candidate, [prior[0] + 1, prior[1] || unconditional])
      }
    }
    for (const [candidate, [count, unconditional]] of hits) {
      if (count > 1 || branches === 1 && unconditional) scoped.add(candidate)
    }
  }
  const pool = (structural.size > 0
    ? candidates.filter((id) => scoped.has(id)
      || relevant.includes(id) && stable.has(id))
    : relevant.length > 0 ? relevant : candidates)
    .sort((left, right) => forward[0].get(right)! - forward[0].get(left)!
      || Number(structural.has(right)) - Number(structural.has(left))
      || score(v[1].get(right)!, targets) - score(v[1].get(left)!, targets)
      || cmp(left, right))
  const allowed = forward[0]
  const terminals = pool.filter((id) => {
    const below = reach(
      v, [id], false, limit, accept, allowed,
    )[0]
    return !pool.some((other) => other !== id && below.has(other))
  })
  if (terminals.length === 0) terminals.push(...pool.slice(0, 1))
  const selected = terminals.length > 0 ? forward
      : reach(v, [root], false, limit, accept, undefined, v[4]),
    backward = reach(v, terminals, true, limit, accept, allowed)
  let symbols = new Set([...selected[0].keys()].filter((id) =>
    terminals.length === 0 || backward[0].has(id)))
  let arcs = [...v[2].values()].flat().filter((arc) =>
    symbols.has(arc[0]) && symbols.has(arc[1]) && (!accept || accept(arc)))
  let pruned = false
  const relationCount = new Set(arcs.flatMap(idsOf)).size,
    hardLimit = relationCount > HOPS
  if (relationCount > 20) {
    if (terminals[0]) {
      const all = arcs
      if (terminals.length === 1) {
        const selected = bestPath(
          v, root, terminals[0], symbols, targets, accept,
        )
        arcs = selected[0]
        const originalCycles = cycleGroups(symbols, all)
        for (const cycle of originalCycles) {
          const members = new Set(cycle.symbolIds)
          if (![...members].every((id) =>
            arcs.some((arc) => arc[0] === id || arc[1] === id))) continue
          const closes = () => cycleGroups(
            new Set(arcs.flatMap((arc) => [arc[0], arc[1]])), arcs,
          ).some((group) => group.symbolIds.every((id) => members.has(id))
            && [...members].every((id) => group.symbolIds.includes(id)))
          const candidates = all.filter((arc) => !arcs.includes(arc)
            && members.has(arc[0]) && members.has(arc[1]))
            .sort((left, right) =>
              Number(arcs.some((arc) => arc[0] === left[0] && arc[1] === left[1]))
              - Number(arcs.some((arc) => arc[0] === right[0] && arc[1] === right[1]))
              || cmp(left[3][0]![0], right[3][0]![0]))
          for (const candidate of candidates) {
            if (closes()) break
            if (new Set([...arcs, candidate].flatMap(idsOf)).size <= HOPS) {
              arcs.push(candidate)
            }
          }
        }
        const kept = new Set(arcs.flatMap((arc) =>
          arc[3].flatMap((edge) => [edge[1], edge[2]])))
        const omitted = all.filter((arc) => !arcs.includes(arc)),
          newNodes = new Set(omitted.flatMap((arc) => [arc[0], arc[1]])
            .filter((id) => !kept.has(id))),
          safe = new Set(kept),
          keptOperations = new Set(arcs.flatMap((arc) => arc[4])),
          unsafeSameEndpoint = omitted.some((arc) =>
            kept.has(arc[0]) && kept.has(arc[1])
            && !arc[4].some((id) => keptOperations.has(id)
              || v[6].get(id)?.control.some((frame) => frame.kind !== 'exception')))
        let changed = true
        while (changed) {
          changed = false
          for (const arc of omitted) if (safe.has(arc[0]) && !safe.has(arc[1])
            && (!kept.has(arc[0]) || arc[4].some((id) =>
              v[6].get(id)?.control.some((frame) => frame.kind !== 'exception')))) {
            safe.add(arc[1]); changed = true
          }
        }
        const cyclesPreserved = originalCycles.every((cycle) =>
          cycle.symbolIds.some((id) => !kept.has(id))
          || cycleGroups(new Set(kept), arcs).some((group) =>
            group.symbolIds.length === cycle.symbolIds.length
            && group.symbolIds.every((id) => cycle.symbolIds.includes(id))))
        pruned = selected[1] || !cyclesPreserved
          || newNodes.size > 2 || [...newNodes].some((id) => !safe.has(id))
          || unsafeSameEndpoint
        if (pruned && !hardLimit) { arcs = all; pruned = false }
      } else {
        const paths = terminals.map((terminal) => {
          const path: Arc[] = []
          for (let id = terminal; id !== root;) {
            const arc = forward[3].get(id)
            if (!arc) return []
            path.unshift(arc); id = arc[0]
          }
          return path
        })
        const need = [...new Map(paths.flat().map((arc) =>
          [idsOf(arc).join('\0'), arc])).values()]
        const kept = new Set(need.flatMap((arc) =>
          arc[3].flatMap((edge) => [edge[1], edge[2]])))
        pruned = paths.some((path) => path.length === 0)
          || new Set(need.flatMap(idsOf)).size > HOPS
          || all.some((arc) => (!accept || accept(arc)) && !need.includes(arc)
            && arc[3].some((edge) => !kept.has(edge[1]) || !kept.has(edge[2])))
        arcs = pruned ? paths[0]! : need
        if (pruned && !hardLimit) { arcs = all; pruned = false }
      }
      symbols = new Set([root, ...arcs.flatMap((arc) => [arc[0], arc[1]])])
    } else {
      arcs = []; symbols = new Set([root])
      pruned = true
    }
  }
  arcs.sort((left, right) =>
    (forward[0].get(left[0]) ?? Infinity) - (forward[0].get(right[0]) ?? Infinity)
    || (forward[0].get(left[1]) ?? Infinity) - (forward[0].get(right[1]) ?? Infinity)
    || cmp(left[0], right[0]) || cmp(left[1], right[1])
    || cmp(left[3][0]![0], right[3][0]![0]))
  return [symbols, arcs, terminals.filter((id) => symbols.has(id)),
    forward[1], terminals.length === 0 && (forward[2] || selected[2]) || pruned]
}
type PersistenceFact = Extract<IndexBodyFact, { kind: 'persistence' }>
function typedCase(value: IndexValue | undefined): string | undefined {
  if (!value || value.kind !== 'literal') return undefined
  return `case:${Buffer.from(JSON.stringify([
    typeof value.value, value.value,
  ])).toString('base64url')}`
}
function objectPath(value: IndexValue, path: readonly string[]): IndexValue | undefined {
  let current: IndexValue | undefined = value
  for (const key of path) {
    if (current?.kind !== 'object') return undefined
    current = current.entries.find((entry) => entry.key === key)?.value
  }
  return current
}
function channelTerminals(
  i: ReadyQueryIndex, arc: Arc, candidates: readonly PersistenceFact[],
): PersistenceFact[] {
  if (arc[2] !== 'channel') return [...candidates]
  const publish = arc[3][0], position = publish?.[8]
  if (!publish || position === undefined) return []
  const call = arc[4].map((id) => i.operation_by_id.get(id)).find((fact) =>
    fact?.kind === 'call' && fact.owner_symbol_id === arc[0]
    && rangeKey(fact.evidence.range) === publish[4]
    && rangeKey(fact.evidence.statement_range) === publish[5])
  if (call?.kind !== 'call' || position >= call.arguments.length) return []
  const transport = i.channels_by_id.get(publish[2])?.transport,
    matches: Array<readonly [string, PersistenceFact[]]> = []
  for (const condition of i.operations_by_owner.get(arc[1]) ?? []) {
    if (condition.kind !== 'condition' || condition.condition_kind !== 'switch'
      || condition.test?.kind !== 'template') continue
    const [parameter, ...rawPath] = condition.test.parts
    if (parameter?.kind !== 'parameter' || parameter.position !== 0
      || rawPath.some((part) => part.kind !== 'literal'
        || typeof part.value !== 'string')) continue
    const path = rawPath.map((part) => (part as Extract<IndexValue, {
      kind: 'literal'
    }>).value as string)
    if (transport === 'bullmq' && path[0] === 'data') path.shift()
    const arm = typedCase(objectPath(call.arguments[position]!, path))
    if (!arm) continue
    const eligible = candidates.filter((fact) => fact.control.some((frame) =>
      frame.kind === 'branch' && frame.controller_fact_id === condition.id
      && frame.arm === arm))
    if (eligible.length > 0) matches.push([condition.id, eligible])
  }
  return matches.length === 1 ? matches[0]![1] : []
}
function controls(
  i: ReadyQueryIndex, arcs: readonly Arc[], terminals: readonly string[],
  seeds: readonly string[],
): Control {
  const close = (ids: Iterable<string>): [Set<string>, boolean] => {
    const result = new Set(ids), queue = [...result]
    let valid = true
    const add = (id: string): void => {
      if (!result.has(id)) { result.add(id); queue.push(id) }
    }
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const fact = i.operation_by_id.get(queue[cursor]!)
      if (!fact) { valid = false; continue }
      for (const frame of fact.control) {
        if (frame.kind !== 'exception') add(frame.controller_fact_id)
      }
      if (fact.kind === 'parallel') fact.member_fact_ids.forEach(add)
      if (fact.kind === 'persistence') add(fact.call_fact_id)
    }
    return [result, valid]
  }
  const cost = (fact: IndexBodyFact): readonly [number, number, number, string] => {
    const closure = close([fact.id])[0],
      call = fact.kind === 'persistence'
        ? i.operation_by_id.get(fact.call_fact_id) : fact,
      adverse = call?.kind === 'call'
        && call.control.some((frame) =>
          frame.kind === 'exception' && frame.arm === 'catch') ? 1 : 0,
      range = fact.evidence.statement_range,
      span = (range.end.line - range.start.line) * 1_000
        + range.end.column - range.start.column
    return [adverse, closure.size, span, fact.id]
  }
  const prefer = (left: IndexBodyFact, right: IndexBodyFact): number => {
    const a = cost(left), b = cost(right)
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
      || orderCmp(right.order, left.order) || cmp(a[3], b[3])
  }
  const primary = new Set(seeds),
    facts = [...new Set(arcs.flatMap((arc) => arc[4]))]
      .map((id) => i.operation_by_id.get(id))
      .filter((fact): fact is IndexBodyFact => fact !== undefined)
  facts.forEach((fact) => primary.add(fact.id))
  const terminalOperations = new Set<string>()
  for (const id of [...terminals].sort(cmp)) {
    const candidates = (i.operations_by_owner.get(id) ?? []).filter(terminal),
      incoming = arcs.filter((arc) => arc[1] === id && arc[2] === 'channel'),
      groups = incoming.length > 0
        ? incoming.map((arc) => channelTerminals(i, arc, candidates)) : [candidates]
    if (groups.some((group) => group.length === 0)) continue
    for (const group of groups) {
      const fact = group.sort(prefer)[0]
      if (fact) { primary.add(fact.id); terminalOperations.add(fact.id) }
    }
  }
  type Group = [kind: 'branch' | 'loop' | 'parallel', controller: string,
    arm: string | undefined, operations: Set<string>, symbols: Set<string>]
  const grouped = new Map<string, Group>(),
    sequences = new Map<string, Extract<IndexBodyFact, { kind: 'call' }>[]>()
  for (const fact of facts) {
    if (fact.kind === 'call'
      && !fact.control.some((frame) => frame.kind === 'parallel')) {
      append(sequences, `${fact.owner_symbol_id}\0${JSON.stringify(fact.control)}`, fact)
    }
  }
  const orderGroups: WorkflowControlGroup[] = []
  for (const calls of sequences.values()) if (calls.length > 1) {
    calls.sort((a, b) => orderCmp(a.order, b.order) || cmp(a.id, b.id))
    orderGroups.push({
      kind: 'sequence', operationIds: calls.map((fact) => fact.id),
      symbolIds: calls.flatMap((fact) => fact.target_symbol_id ? [fact.target_symbol_id] : []),
    })
  }
  const [needed, proven] = close(primary)
  for (const id of needed) {
    const fact = i.operation_by_id.get(id)
    if (!fact) continue
    for (const frame of fact.control) {
      if (frame.kind === 'exception') continue
      const arm = frame.kind === 'branch' ? frame.arm : undefined
      const key = `${frame.kind}\0${frame.controller_fact_id}\0${arm ?? ''}`
      const group = grouped.get(key)
        ?? [frame.kind, frame.controller_fact_id, arm, new Set(), new Set()] as Group
      grouped.set(key, group)
      group[3].add(fact.id); group[4].add(fact.owner_symbol_id)
    }
  }
  const groups = [...grouped.values()]
    .map<WorkflowControlGroup>(([
      kind, controllerOperationId, arm, operations, symbols,
    ]) => ({
      kind, controllerOperationId, ...(arm ? { arm } : {}),
      operationIds: [...operations].sort(cmp), symbolIds: [...symbols].sort(cmp),
    })).concat(orderGroups)
  return [[...needed].sort(cmp), groups, proven, [...terminalOperations].sort(cmp)]
}
function cycleGroups(symbols: ReadonlySet<string>, arcs: readonly Arc[]): WorkflowControlGroup[] {
  const paths = new Map([...symbols].map((id) => [id, new Set<string>()]))
  for (const arc of arcs) paths.get(arc[0])?.add(arc[1])
  for (const through of symbols) for (const from of symbols) {
    if (!paths.get(from)?.has(through)) continue
    for (const to of paths.get(through) ?? []) paths.get(from)!.add(to)
  }
  const groups: WorkflowControlGroup[] = []
  for (const symbol of symbols) {
    const members = [...symbols].filter((candidate) =>
      paths.get(symbol)?.has(candidate) && paths.get(candidate)?.has(symbol)).sort(cmp)
    if (members[0] !== symbol) continue
    groups.push({ kind: 'cycle', operationIds: [], symbolIds: members })
  }
  return groups
}
function matches(
  symbol: SymbolNode, lexical: readonly string[], names: boolean,
): boolean {
  if (lexical.length === 0) return true
  const source = names ? symbol[2] : symbol[1],
    tokens = names ? symbol[4] : symbol[3]
  return source.includes(lexical.join(''))
    || lexical.every((term) => tokens.has(term))
}
function covering(
  v: ExecutionView,
  ids: readonly string[],
  target: string,
  names: boolean,
): string[] {
  const lexical = words(target),
    exact = ids.filter((id) => matches(v[1].get(id)!, lexical, names))
  if (exact.length > 0) return exact
  const related = ids.filter((id) => {
      const symbol = v[1].get(id)!,
        tokens = names ? symbol[4] : symbol[3]
      return lexical.some((term) => tokens.has(term))
    })
  return lexical.length > 0
    && lexical.every((term) => related.some((id) =>
      (names ? v[1].get(id)![4] : v[1].get(id)![3]).has(term)))
    ? related : []
}
function targetSymbols(
  v: ExecutionView, ids: readonly string[], target: string,
  role: 'entry' | 'stage' | 'behavior' | 'terminal',
): string[] {
  const tokens = words(target)
  if (role === 'entry' && tokens.includes('request')) {
    const entries = ids.filter((id) => v[1].get(id)![8]),
      rest = tokens.filter((token) => token !== 'request')
    return rest.length === 0 ? entries : entries.filter((id) =>
      rest.every((token) => v[1].get(id)![3].has(token)))
  }
  const exact = ids.filter((id) => matches(v[1].get(id)!, tokens, false))
  if (exact.length > 0) return exact
  if (role === 'terminal' && tokens.length > 0) {
    const generic = new Set([
        'data', 'persist', 'persistence', 'record', 'storage', 'store', 'write',
      ]),
      specific = tokens.filter((token) => !generic.has(token))
    if (specific.length === 0) return [...ids]
    const stored = ids.filter((id) => specific.every((token) => {
      const lexicon = v[1].get(id)![3]
      return lexicon.has(token) || /^(?:database|db)$/u.test(token)
        && ['database', 'db', 'mongo', 'mongodb', 'repository', 'sql']
          .some((candidate) => lexicon.has(candidate))
    }))
    if (stored.length > 0) return stored
  }
  return role === 'stage' || role === 'behavior'
    ? covering(v, ids, target, false) : []
}
function channelMatches(
  i: ReadyQueryIndex, id: string, target: string,
): boolean {
  const channel = i.channels_by_id.get(id)
  if (!channel) return false
  const expected = words(target), actual = new Set(words(
      `${channel.channel_kind} ${channel.transport} ${channel.key}`,
    )),
    compact = expected.join(''),
    forms = [
      `${channel.channel_kind} ${channel.transport} ${channel.key}`,
      `${channel.transport} ${channel.channel_kind} ${channel.key}`, channel.key,
    ].map((value) => words(value).join(''))
  return expected.length > 0 && (expected.every((token) => actual.has(token))
    || forms.some((value) => value.includes(compact)))
}
function stageMatches(
  i: ReadyQueryIndex, v: ExecutionView, selection: Selection, target: string,
): boolean {
  const steps = [...selection[0]].filter((id) =>
    id !== selection[2][0] && targetSymbols(v, [id], target, 'stage').length > 0)
  return steps.length > 0 || selection[1].some((arc) =>
    arc[3].some((edge) =>
      channelMatches(i, edge[1], target) || channelMatches(i, edge[2], target)))
}
const named = (v: ExecutionView, id: string, target: string): boolean =>
  matches(v[1].get(id)!, words(target), true)
function findRoots(
  v: ExecutionView,
  ranked: readonly Candidate[],
  targets: readonly string[],
): readonly [ids: string[], actual: Set<string>, bounded: boolean] {
  const traversal = reach(
    v, ranked.map((entry) => entry[0][0]), true, RECOVERY,
  )
  const rank = (id: string): number => {
    const symbol = v[1].get(id)!
    return rootScore(v, symbol, score(symbol, targets))
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
  const v = buildView(i),
    { intent, subject: target, terms, obligations, access } = plan,
    isFlow = intent === 'workflow',
    targets = [...new Set([
      target, ...terms, ...obligations.map((entry) => entry.target),
    ])],
    terminalTarget = obligations.find((entry) => entry.kind === 'terminal')?.target,
    terminalHint = terminalTarget === target ? undefined : terminalTarget,
    stageTarget = obligations.find((entry) => entry.kind === 'stage'
      && entry.target !== target)?.target
  const candidate = (symbol: SymbolNode): Candidate => {
    const lexical = score(symbol, targets),
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
            || symbol[5].some((fact) => fact.kind === 'mutation')
            || [...symbol[4]].some((word) =>
              ['persist', 'save', 'set', 'store', 'update', 'write'].includes(word)))
            : Number(symbol[5].some((fact) => fact.kind === 'persistence'
              && READ.test(fact.operation))
              || [...symbol[4]].some((word) =>
                ['find', 'get', 'load', 'read'].includes(word))),
      exact = isFlow ? Number(!v[5].has(symbol[0]))
        : intent === 'locate'
          ? Number(named(v, symbol[0], target))
          : Number(named(v, symbol[0], target))
    return [symbol, lexical, rootScore(v, symbol, lexical), affinity, exact]
  }
  const ranked = v[0].map(candidate)
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
        : b[4] - a[4] || b[3] - a[3]
          || b[2] - a[2] || b[1] - a[1] || cmp(a[0][0], b[0][0]))
    .slice(0, CANDIDATES),
    focus = ranked[0]?.[0][0]
  const entryTarget = obligations.find((entry) => entry.kind === 'entry'
      && entry.target !== target)?.target,
    entryPool = isFlow ? ranked.filter((entry) => !v[5].has(entry[0][0])) : [],
    constrainedEntries = entryTarget
      ? new Set(targetSymbols(v, entryPool.map((entry) => entry[0][0]),
        entryTarget, 'entry')) : undefined
  let entries = entryPool.filter((entry) =>
    !constrainedEntries || constrainedEntries.has(entry[0][0])).slice(0, 3)
  let bridge: ReturnType<typeof findRoots> | undefined
  if (!entryTarget && isFlow && ranked.length > 0 && (entries.length === 0
    || entries.every((entry) => entry[0][7] !== 'production'))) {
    bridge = findRoots(v, ranked, targets)
    const recovered = bridge[0].map((id) => candidate(v[1].get(id)!))
    entries = [...new Map([...recovered, ...entries].map((entry) =>
      [entry[0][0], entry])).values()]
      .sort((left, right) =>
        penalty(left[0][7]) - penalty(right[0][7])
        || right[2] - left[2] || cmp(left[0][0], right[0][0]))
      .slice(0, 3)
  }
  let root: string | undefined
  const subjectTerms = new Set(words(target)),
    callTarget = terms.filter((term) => !subjectTerms.has(term)).join(' '),
    direct = focus && intent === 'explain'
      ? (v[2].get(focus) ?? []).filter((arc) => arc[2] === 'direct') : [],
    requested = callTarget ? direct.find((arc) =>
      named(v, arc[1], callTarget)) : undefined,
    callArcs = direct.filter((arc) =>
      arc === requested || score(v[1].get(arc[1])!, targets) > 0)
      .sort((a, b) => Number(b === requested) - Number(a === requested)
        || score(v[1].get(b[1])!, targets) - score(v[1].get(a[1])!, targets)
        || cmp(a[1], b[1])).slice(0, 3),
    ids = focus ? [focus, ...callArcs.map((arc) => arc[1])] : []
  let flow: Selection = isFlow ? [new Set(), [], [], new Set(), false]
    : [new Set(ids), callArcs, [], new Set(ids), false]
  const seen = new Set<string>()
  let tries = isFlow ? 0 : focus ? 1 : 0
  let locked = false
  for (const entry of entries) {
    const id = entry[0][0]
    const room = NODES - RECOVERY - seen.size
    if (room <= 0) break
    const trial = corridor(v, id, room, targets, terminalHint)
    trial[3].forEach((candidate) => seen.add(candidate))
    tries += 1
    const stageFit = !stageTarget || stageMatches(i, v, trial, stageTarget),
      priorStageFit = !stageTarget || stageMatches(i, v, flow, stageTarget)
    if (root === undefined || !locked && (Number(stageFit) > Number(priorStageFit)
      || stageFit === priorStageFit
      && (Number(trial[2].length > 0) > Number(flow[2].length > 0)
        || Boolean(trial[2].length) === Boolean(flow[2].length)
          && flow[4] && !trial[4]))) {
      root = id
      flow = trial
      locked = !terminalHint && !stageTarget && trial[2].length === 0
        && named(v, id, target)
        && (trial[1].length > 0 || v[4].has(id))
    }
  }

  // Pass two is a bounded, shared recovery frontier. Alternates are admitted
  // only when they are structural entries; disconnected middle-stage matches
  // can never manufacture an entry-to-persistence corridor.
  const recovery = new Set<string>()
  bridge?.[1].forEach((id) => recovery.add(id))
  flow[3].forEach((id) => seen.add(id))
  let bounded = flow[4]
  let passes: 0 | 1 | 2 = bridge ? 1 : 0
  if (!entryTarget && isFlow && (flow[2].length === 0 || flow[4])
    && ranked.length > 0) {
    bridge ??= findRoots(v, ranked, targets)
    bridge[1].forEach((id) => { recovery.add(id); seen.add(id) })
    bounded ||= bridge[2]
    passes = 1
    const alternates = flow[2].length === 0 && !locked
      ? bridge[0].filter((id) => id !== root).slice(0, 3 - tries) : []
    if (alternates.length > 0) passes = 2
    for (const id of alternates) {
      tries += 1
      const room = RECOVERY - recovery.size + 1
      if (room <= 0) { bounded = true; break }
      const trial = corridor(v, id, room, targets, terminalHint)
      bounded ||= trial[4]
      trial[3].forEach((entry) => { recovery.add(entry); seen.add(entry) })
      if (root !== undefined && v[4].has(root) && named(v, root, target)) continue
      root = id; flow = trial; break
    }
  } else if (intent === 'explain' && focus
    && !(v[1].get(focus)?.[5].some(behavior) ?? false)) {
    const alternate = ranked.slice(1, 4).find((entry) =>
      entry[0][5].some(behavior))
    if (alternate) {
      passes = 1
      tries += 1
      const id = alternate[0][0]
      recovery.add(id); seen.add(id)
      flow = [new Set([id]), [], [], new Set([id]), false]
    }
  }
  const rootIds = isFlow
    ? root && flow[0].has(root) ? [root] : []
    : callArcs.length > 0 && focus ? [focus] : []
  const causal = [...new Set([
    ...rootIds, ...flow[2], ...flow[1].flatMap((arc) => [arc[0], arc[1]]),
  ])].sort(cmp)
  const symbolIds = [...flow[0]].sort(cmp),
    edges = [...new Map(flow[1].flatMap((arc) =>
      arc[3].map((edge) => [edge[0], edge] as const))).values()]
      .map(([id, fromId, toId, relation]) =>
      ({ id, fromId, toId, relation })).sort((a, b) => cmp(a.id, b.id)),
    subjects = covering(
      v, symbolIds, target, intent === 'locate' && !access,
    ),
    behaviors = isFlow ? causal : subjects,
    edgeOwners = new Set(flow[1].map((arc) => arc[0])),
    failureIntent = targets.some((entry) =>
      words(entry).some((word) => FAILURE_WORD.test(word)))
  const factSeeds = intent === 'locate' ? [] : behaviors
    .filter((id) => !edgeOwners.has(id) && !flow[2].includes(id)).flatMap((id) => {
    const facts = v[1].get(id)?.[5].filter((fact) =>
      behavior(fact) && (failureIntent || !adverseFact(fact))) ?? []
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
    : controls(i, flow[1], flow[2], factSeeds)
  const steps = isFlow ? causal : symbolIds,
    edgeIds = edges.map((edge) => edge.id),
    chosenOps = new Set(ctl[0]),
    terminalSymbols = [...new Set(ctl[3].map((id) =>
      i.operation_by_id.get(id)?.owner_symbol_id).filter(
      (id): id is string => id !== undefined,
    ))].sort(cmp),
    arcOps = [...new Set(flow[1].flatMap((arc) => arc[4]))]
      .filter((id) => chosenOps.has(id))
  const owned = (ids: readonly string[]): string[] => ctl[0].filter((id) =>
    ids.includes(i.operation_by_id.get(id)?.owner_symbol_id as string))
  const behaviorOps = owned(behaviors)
  const inert = behaviors.filter((id) => !edgeOwners.has(id)
    && !behaviorOps.some((operation) =>
    i.operation_by_id.get(operation)?.owner_symbol_id === id))
  const incomplete = causal.filter((id) => v[4].has(id))
  type ProofData = readonly [
    symbols: readonly string[], operations: readonly string[], proven: boolean,
  ]
  const data: Record<ObligationKind, ProofData> = {
    subject: [subjects, intent === 'locate' && access ? locateOps : owned(subjects),
      subjects.length > 0 && (!access || locateOps.length > 0)],
    entry: [rootIds, owned(rootIds), rootIds.length > 0],
    stage: [steps, ctl[0], steps.length > 0],
    handoff: [causal, isFlow ? arcOps : owned(causal),
      flow[1].length > 0 && (!isFlow || incomplete.length === 0)],
    behavior: [behaviors, behaviorOps,
      behaviors.length > 0 && inert.length === 0],
    ordering: [steps, arcOps,
      flow[1].length > 0 && incomplete.length === 0 && ctl[2]
      && flow[1].every((arc) => arc[4].length > 0)],
    terminal: [terminalSymbols, ctl[3], terminalSymbols.length > 0],
  }
  const missing: WorkflowMissingReason[] = []
  const proofs = obligations.map((obligation): WorkflowObligationProof => {
    let [symbolIds, operationIds, proven] = data[obligation.kind]
    let proofEdges = /^(?:stage|handoff|behavior|ordering)$/u
      .test(obligation.kind) ? edgeIds : []
    if (obligation.target !== target
      && /^(?:entry|stage|behavior|terminal)$/u.test(obligation.kind)) {
      const role = obligation.kind as 'entry' | 'stage' | 'behavior' | 'terminal',
        domain = role === 'entry' ? rootIds
          : role === 'terminal' ? terminalSymbols
            : role === 'stage' ? steps.filter((id) =>
              !rootIds.includes(id) && !flow[2].includes(id)) : [...flow[0]]
      let matched = targetSymbols(v, domain, obligation.target, role)
      if (role === 'stage') proofEdges = []
      if (role === 'stage' && matched.length === 0) {
        const expected = words(obligation.target)
        proofEdges = edges.filter((edge) =>
          [edge.fromId, edge.toId].some((id) => {
            return expected.length > 0 && channelMatches(i, id, obligation.target)
          })).map((edge) => edge.id)
        const ids = new Set(proofEdges)
        const arcs = flow[1].filter((arc) =>
          arc[3].some((edge) => ids.has(edge[0])))
        matched = [...new Set(arcs.flatMap((arc) => [arc[0], arc[1]]))].sort(cmp)
        operationIds = [...new Set(arcs.flatMap((arc) => arc[4]))]
          .filter((id) => chosenOps.has(id)).sort(cmp)
      } else {
        operationIds = ctl[0].filter((id) => {
          const fact = i.operation_by_id.get(id)
          return !!fact && (matched.includes(fact.owner_symbol_id)
            || fact.kind === 'call' && !!fact.target_symbol_id
              && matched.includes(fact.target_symbol_id))
        })
      }
      symbolIds = matched
      proven = proven && matched.length > 0
    }
    const proof = {
      ...obligation, proven, symbolIds, operationIds, edgeIds: proofEdges,
    }
    if (proof.mandatory && !proof.proven) {
      missing.push({ code: MISSING_CODES[proof.kind] ?? 'obligation_target_unproven',
        target: proof.kind === 'handoff' && incomplete.length > 0
          ? incomplete.join(',') : proof.target,
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
    terminalSymbolIds: terminalSymbols,
    edges,
    links: flow[1].map((arc) => ({
      fromId: arc[0], toId: arc[1], kind: arc[2],
      edgeIds: idsOf(arc),
      operationIds: arc[4].filter((id) =>
        chosenOps.has(id) && i.operation_by_id.get(id)?.owner_symbol_id === arc[0]),
    })),
    controlGroups: [...ctl[1], ...cycleGroups(new Set(causal), flow[1])],
    obligations: proofs,
    missing,
    metrics: {
      candidateCount: ranked.length, rootCandidateCount: tries,
      actualNodeCount: seen.size,
      causalRelationHops: edges.length, recoveryPasses: passes,
      recoveryFrontierCount: recovery.size, bounded,
    },
  }
}
