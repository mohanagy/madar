import { compareCodeUnits as compare } from '../graph/canonical-json.js'
import type { GraphAttributes } from '../graph/directed-multigraph.js'
import type { ReadyQueryIndex } from './index-status.js'
import {
  classifySourceDomain, isPollutedSourcePath, sourceDomainOf, type SourceDomain,
} from './source-domain.js'
import type {
  EvidenceBoundary, NormalizedRetrieveRequest, RankedQueryNode, RankQueryResult,
} from './types.js'
import {
  MAX_RETRIEVE_FILES as FILE_CAP, MAX_RETRIEVE_SNIPPETS as SNIPPET_CAP,
} from './types.js'

const CAUSAL = new Set(['calls', 'enqueues_job'])
const RELATIONS = ['calls', 'contains', 'enqueues_job', 'imports_from']
const LAST = Number.MAX_SAFE_INTEGER
const STOP = new Set(
  'a actual an and any applicabl are as at be by bas being can do does exist final for from handl explain how in initial is it its me new of on operat or specific tell that the then through to trace what when which with you'.split(' '),
)
const UNSUPPORTED =
  /^(?:bash|c|cc|cljs|clj|cpp|cs|cxx|dart|elm|ex|exs|fs|fsx|go|groovy|h|hpp|hs|java|jl|kt|kts|lua|m|mm|php|ps1|py|r|rb|rs|scala|sh|sol|sql|svelte|swift|vue|zig)$/u
const DOMAIN_TERMS: Readonly<Record<string, readonly string[]>> = {
  test: ['test', 'spec', 'e2e'],
  benchmark: ['benchmark', 'bench', 'performance'],
  fixture: ['fixture', 'mock'],
  generated: ['generated'],
  docs: ['doc', 'documentation', 'readme'],
  config: ['config', 'configuration', 'setting'],
}
const STEMS = [
  [7, 'ization', 'ize'], [5, 'ies', 'y'], [6, 'ence', ''], [6, 'ance', ''],
  [8, 'ment', ''], [5, 'ions', ''], [4, 'ion', ''], [5, 'ing', ''],
  [4, 'ery', 'er'], [4, 'ed', ''], [4, 's', ''], [5, 'e', ''],
] as const

interface Field { compact: string; tokens: ReadonlySet<string>; weight: number }
interface Node {
  id: string; attributes: GraphAttributes; file: string; kind: string
  domain: SourceDomain; fields: readonly Field[]; tokens: ReadonlySet<string>
  pathTokens: ReadonlySet<string>; incoming: string[]; outgoing: string[]
  owner?: string; eligible: boolean; defined: boolean
}
interface Corpus {
  nodes: readonly Node[]; byId: ReadonlyMap<string, Node>
  members: ReadonlyMap<string, readonly string[]>
  files: ReadonlyMap<string, readonly Node[]>
  frequency: ReadonlyMap<string, number>; documents: number
}
interface Scope {
  subject: string; tokens: string[]; compact: string; first: number
  restricts: boolean
}
interface Vocabulary {
  question: string; terms: string[]; positions: ReadonlyMap<string, number>
  scopes: Scope[]; limits: Scope[]; concepts: readonly ReadonlySet<string>[]
  structural: boolean; expand: boolean
}
interface Scored { node: Node; ranked: RankedQueryNode }
interface Seed extends Scored { direct: string[]; concepts: number[] }
interface Selection {
  ids: string[]; flow: boolean; complete: boolean
  structuralRequired: boolean; branch?: string
}
interface UnsupportedCandidate {
  path: string; terms: string[]; weights: ReadonlyMap<string, number>
  score: number; first: number
}

const corpusCache = new WeakMap<ReadyQueryIndex, WeakRef<Corpus>>()

function stem(value: string): string {
  if (/^\d+$/.test(value)) return value
  let result = value
  for (let pass = 0; pass < 2; pass += 1) {
    const rule = STEMS.find(([minimum, suffix]) =>
      result.length > minimum && result.endsWith(suffix)
      && (suffix !== 's' || !result.endsWith('ss')))
    if (!rule) break
    result = `${result.slice(0, -rule[1].length)}${rule[2]}`
  }
  return result
}

function tokens(value: string): string[] {
  const separated = value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
  return (separated.match(/[a-z][a-z0-9]*|\d+/g) ?? [])
    .flatMap((token) => {
      const parts = token.match(/[a-z]+|\d+/g) ?? []
      return parts.length >= 3 ? parts : [token]
    })
    .map(stem)
    .filter((token) => token.length > 1 || /^\d+$/.test(token))
}

function meaningful(value: string): string[] {
  return tokens(value).filter((token) => !STOP.has(token))
}

function matches(values: ReadonlySet<string>, term: string): boolean {
  if (values.has(term)) return true
  if (term.length < 3) return false
  const singular = term.length >= 4 && term.endsWith('s') && !term.endsWith('ss')
    ? term.slice(0, -1) : `${term}s`
  const bare = term.endsWith('e') ? term.slice(0, -1) : `${term}e`
  for (const form of [term, singular, bare]) {
    if (values.has(form)) return true
    for (const prefix of ['en', 're', 'un']) {
      if (values.has(`${prefix}${form}`)
        || (form.startsWith(prefix) && values.has(form.slice(prefix.length)))) return true
    }
  }
  return false
}

function text(attributes: GraphAttributes, key: string): string {
  const value = attributes[key]
  return typeof value === 'string' ? value : ''
}

function makeField(value: string, weight: number): Field | null {
  const lexical = tokens(value)
  return lexical.length === 0 ? null : {
    compact: lexical.join(''), tokens: new Set(lexical), weight,
  }
}

function buildCorpus(index: ReadyQueryIndex): Corpus {
  const cached = corpusCache.get(index)?.deref()
  if (cached) return cached
  const nodes: Node[] = []
  for (const [id, attributes] of index.graph.nodeEntries()) {
    const file = text(attributes, 'source_file')
    const kind = text(attributes, 'node_kind')
    const fields = [
      makeField(text(attributes, 'label'), 12),
      makeField(text(attributes, 'qualified_name'), 12),
      makeField(`${text(attributes, 'framework')} ${
        text(attributes, 'framework_role')}`, 5),
      makeField(JSON.stringify(attributes.framework_metadata) ?? '', 5),
      makeField(kind, 3),
      makeField(file, 7),
    ].filter((field): field is Field => !!field)
    const eligible = !isPollutedSourcePath(file, index.root_path)
      && (kind === 'file'
        ? !!file && Array.isArray(attributes.provenance)
          && attributes.provenance.length > 0 && index.file_hashes.has(file)
        : !!attributes.definition_range && !!attributes.declaration_range
          && !(attributes.framework_metadata
            && typeof attributes.framework_metadata === 'object'
            && 'external_call' in attributes.framework_metadata
            && attributes.framework_metadata.external_call === true))
    nodes.push({
      id, attributes, file, kind, fields,
      domain: sourceDomainOf(attributes.source_domain, file, index.root_path),
      tokens: new Set(fields.flatMap((field) => [...field.tokens])),
      pathTokens: new Set(tokens(file)),
      incoming: [], outgoing: [], eligible,
      defined: kind === 'file'
        || JSON.stringify(attributes.declaration_range)
          !== JSON.stringify(attributes.definition_range),
    })
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const members = new Map<string, string[]>()
  for (const [from, to, attributes] of index.graph.edgeEntries()) {
    const source = byId.get(from)
    const target = byId.get(to)
    const relation = text(attributes, 'relation')
    if (source && target && CAUSAL.has(relation)
      && source.kind !== 'file' && target.kind !== 'file') {
      source.outgoing.push(to)
      target.incoming.push(from)
    }
    if (source?.kind === 'class' && target
      && (relation === 'contains' || relation === 'method')) {
      target.owner = from
      const owned = members.get(from) ?? []
      owned.push(to)
      members.set(from, owned)
    }
  }
  for (const node of nodes) {
    node.incoming = [...new Set(node.incoming)].sort(compare)
    node.outgoing = [...new Set(node.outgoing)].sort(compare)
  }
  for (const [owner, owned] of members) {
    members.set(owner, [...new Set(owned)].sort(compare))
  }
  const documents = new Map<string, Set<string>>()
  const files = new Map<string, Node[]>()
  for (const node of nodes) {
    const siblings = files.get(node.file) ?? []
    siblings.push(node)
    files.set(node.file, siblings)
    const document = documents.get(node.file || node.id) ?? new Set<string>()
    for (const field of node.fields) for (const token of field.tokens) document.add(token)
    documents.set(node.file || node.id, document)
  }
  const frequency = new Map<string, number>()
  for (const document of documents.values()) {
    for (const token of document) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1)
    }
  }
  const corpus = {
    nodes, byId, members, files, frequency, documents: documents.size,
  } satisfies Corpus
  corpusCache.set(index, new WeakRef(corpus))
  return corpus
}

function scopes(question: string): Scope[] {
  const result: Scope[] = []
  const seen = new Set<string>()
  const patterns = [
    [/`([A-Za-z_$][A-Za-z0-9_$.:]*)`/g, false],
    [/\b([A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*)\b/g, false],
    [/\b(?:[A-Za-z0-9_$.[\]-]+\/)+[A-Za-z0-9_$.[\]-]+\.(?:[cm]?[jt]sx?)\b/g, true],
    [/\b(?=[a-z0-9-]*\d)[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g, true],
  ] as const
  for (const [pattern, restricts] of patterns) {
    for (const match of question.matchAll(pattern)) {
      const subject = (match[1] ?? match[0]).trim()
      if (subject === match[0] && /^[A-Z]+$/u.test(subject)) continue
      const lexical = tokens(subject)
      const compact = lexical.join('')
      if (!compact || seen.has(compact)) continue
      seen.add(compact)
      result.push({
        subject, tokens: lexical, compact,
        first: match.index ?? LAST, restricts,
      })
    }
  }
  const qualified = result.filter((scope) =>
    !scope.restricts && scope.subject.includes('.'))
  return result.filter((scope) => !qualified.some((parent) =>
    parent !== scope
    && scope.first > parent.first
    && scope.first <= parent.first + parent.subject.length + 1
    && parent.subject.split('.').includes(scope.subject)))
    .sort((left, right) =>
      left.first - right.first || compare(left.subject, right.subject))
}

function vocabulary(question: string): Vocabulary {
  const task = question.replace(/\.\s+(?:cite|use|report)\b[\s\S]*$/iu, '')
  const raw = tokens(task)
  const terms: string[] = []
  const positions = new Map<string, number>()
  for (const [position, term] of raw.entries()) {
    if (!STOP.has(term) && !positions.has(term)) {
      terms.push(term)
      positions.set(term, position)
    }
  }
  const lower = task.toLowerCase()
  for (const relation of RELATIONS) {
    const variants = [relation, relation.replaceAll('_', ' ')]
    const found = variants.map((variant) => lower.indexOf(variant))
      .filter((position) => position >= 0)
    if (found.length > 0 && !positions.has(relation)) {
      terms.push(relation)
      positions.set(relation, Math.min(...found))
    }
  }
  const explicit = scopes(task)
  const parts = task
    .split(/[,;:\u2013\u2014]+|[!?]+|\.(?=\s+[A-Z])|\b(?:and\s+then|then)\b/iu)
    .map(meaningful).filter((part) => part.length > 0)
  const concepts = (parts.length > 0 ? parts : [terms])
    .map((part) => new Set(part))
  const connector = raw.findIndex((term, index) =>
    index > 0 && index < raw.length - 1
    && (term === 'through' || term === 'until'))
  const directed = (raw.includes('from')
    && raw.some((term) => term === 'to' || term === 'through'))
    || connector >= 0
    || raw.some((term, index) =>
      term === 'end' && raw[index + 1] === 'to' && raw[index + 2] === 'end')
  const explainsProcess = raw.includes('how') && terms.length > 1
    && explicit.every((scope) => scope.restricts)
  const structural = directed || concepts.length > 1
    || explainsProcess
    || terms.some((term) => [
      'flow', 'handoff', 'journey', 'lifecycl', 'orchestrat',
      'pipelin', 'process', 'queue', 'sequenc', 'stag',
    ].includes(term))
  const expand = directed || concepts.length > 1
    || (terms.some((term) => term === 'stag' || term === 'stage')
      && terms.some((term) =>
      ['job', 'jobs', 'queue', 'enqueu', 'orchestrat'].includes(term)))
  return {
    question: task, terms, positions, scopes: explicit,
    limits: explicit.filter((scope) => scope.restricts),
    concepts, structural, expand,
  }
}

function inScope(node: Node, scope: Scope): boolean {
  return scope.tokens.every((token) => node.tokens.has(token))
    && node.fields.some((field) => field.compact.includes(scope.compact))
}

function rarity(corpus: Corpus, term: string): number {
  const frequency = corpus.frequency.get(term) ?? 0
  return Math.max(1, Math.round(
    (1 + Math.log2((corpus.documents + 1) / (frequency + 1))) * 64,
  ))
}

function exactLabel(node: Node, query: Vocabulary): boolean {
  const label = text(node.attributes, 'label')
  const identifier = label.replace(/^\./u, '').replace(/\(\)$/u, '')
  return (label.endsWith('()') || /[A-Z_$\d.:]/u.test(identifier))
    && meaningful(identifier).length > 0 && query.question.includes(identifier)
}

function directTerms(node: Node, query: Vocabulary, semantic = false): string[] {
  return query.terms.filter((term) => node.fields.some((field) =>
    (!semantic || field.weight !== 7) && matches(field.tokens, term)))
}

function score(
  corpus: Corpus, node: Node, query: Vocabulary,
): RankedQueryNode | null {
  const direct = directTerms(node, query)
  const context = query.terms.filter((term) => !direct.includes(term)
    && [...node.incoming, ...node.outgoing].some((id) => {
      const adjacent = corpus.byId.get(id)
      return !!adjacent?.eligible && matches(adjacent.tokens, term)
    }))
  if (direct.length === 0 && context.length === 0
    && !query.scopes.some((scope) => inScope(node, scope))) return null
  let value = node.domain === 'production' ? 500
    : node.domain === 'test' ? -250
      : node.domain === 'unknown' ? 0 : -500
  for (const term of direct) {
    const weight = Math.max(0, ...node.fields
      .filter((field) => matches(field.tokens, term)).map((field) => field.weight))
    value += rarity(corpus, term) * weight
    if (node.fields.some((field) =>
      field.weight !== 7 && matches(field.tokens, term))) {
      value += rarity(corpus, term) * 12
    }
    if (matches(node.pathTokens, term)) value += rarity(corpus, term) * 7
  }
  for (const term of context) value += rarity(corpus, term) * 5
  for (const scope of query.scopes.filter((scope) => !scope.restricts)) {
    if (node.fields.some((field) => field.compact === scope.compact)) value += 2_000_000
    else if (inScope(node, scope)) value += 1_000_000
  }
  if (exactLabel(node, query)) value += 2_000_000
  const firstMatch = direct.reduce((first, term) =>
    Math.min(first, query.positions.get(term) ?? LAST),
  LAST)
  return {
    id: node.id, attributes: node.attributes, score: value,
    matchedTerms: [...direct, ...context], firstMatch,
  }
}

function compareScored(left: Scored, right: Scored): number {
  return right.ranked.score - left.ranked.score
    || left.ranked.firstMatch - right.ranked.firstMatch
    || right.node.outgoing.length - left.node.outgoing.length
    || compare(left.node.file, right.node.file)
    || compare(left.node.id, right.node.id)
}

function scoredNodes(corpus: Corpus, query: Vocabulary): Scored[] {
  const requestedDomains = new Set(Object.entries(DOMAIN_TERMS)
    .filter(([, terms]) => terms.some((term) => query.terms.includes(term)))
    .map(([domain]) => domain))
  const items = corpus.nodes.flatMap((node): Scored[] => {
    if (!node.eligible
      || (query.limits.length > 0
        && !query.limits.some((scope) => inScope(node, scope)))) return []
    if (node.kind === 'file' && !query.terms.includes('imports_from')
      && !query.limits.some((scope) =>
        scope.subject.includes('/') && inScope(node, scope))) return []
    if ((!node.defined || node.kind === 'interface' || node.kind === 'type-alias')
      && !query.terms.some((term) => tokens(node.kind).includes(term))
      && !query.terms.some((term) => term === 'defin' || term === 'declar')
      && !query.scopes.some((scope) => inScope(node, scope))
      && !exactLabel(node, query)) return []
    if (requestedDomains.size > 0
      ? !requestedDomains.has(node.domain)
      : node.domain !== 'production' && node.domain !== 'unknown'
        && !query.scopes.some((scope) => inScope(node, scope))) return []
    const ranked = score(corpus, node, query)
    if (!ranked) return []
    return [{ node, ranked }]
  }).sort(compareScored)
  if (query.concepts.length > 1 || query.scopes.length > 0) return items
  const byFile = new Map<string, Scored[]>()
  for (const item of items) {
    const current = byFile.get(item.node.file || item.node.id) ?? []
    current.push(item)
    byFile.set(item.node.file || item.node.id, current)
  }
  return [...byFile.values()].flatMap((entries) =>
    entries.sort((left, right) => {
      const ids = new Set(entries.map((entry) => entry.node.id))
      return right.node.outgoing.filter((id) => ids.has(id)).length
        - left.node.outgoing.filter((id) => ids.has(id)).length
        || compareScored(left, right)
    }).slice(0, 2)).sort(compareScored)
}

function executable(node: Node | undefined): node is Node {
  return !!node?.eligible && node.kind !== 'file' && node.kind !== 'class'
}

function path(
  corpus: Corpus, from: string, to: string, backwards = false,
  maximumDepth = 16,
): string[] | null {
  if (from === to) return [from]
  const previous = new Map<string, string>()
  const depth = new Map([[from, 0]])
  const queue = [from]
  for (let cursor = 0; cursor < queue.length && queue.length < 512; cursor += 1) {
    const id = queue[cursor]!
    const distance = depth.get(id) ?? 0
    if (distance >= maximumDepth) continue
    const adjacent = backwards
      ? corpus.byId.get(id)?.incoming ?? []
      : corpus.byId.get(id)?.outgoing ?? []
    for (const next of adjacent) {
      if (depth.has(next)) continue
      depth.set(next, distance + 1)
      previous.set(next, id)
      if (next === to) {
        const result = [to]
        while (result.at(-1) !== from) result.push(previous.get(result.at(-1)!)!)
        return result.reverse()
      }
      queue.push(next)
    }
  }
  return null
}

function causalOrder(corpus: Corpus, input: readonly string[]): {
  ids: string[]; depth: number
} {
  const allowed = new Set(input)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  const components: string[][] = []
  let ordinal = 0
  const visit = (id: string): void => {
    index.set(id, ordinal)
    low.set(id, ordinal++)
    stack.push(id)
    active.add(id)
    for (const next of corpus.byId.get(id)?.outgoing ?? []) {
      if (!allowed.has(next)) continue
      if (!index.has(next)) {
        visit(next)
        low.set(id, Math.min(low.get(id)!, low.get(next)!))
      } else if (active.has(next)) {
        low.set(id, Math.min(low.get(id)!, index.get(next)!))
      }
    }
    if (low.get(id) !== index.get(id)) return
    const component: string[] = []
    while (stack.length > 0) {
      const member = stack.pop()!
      active.delete(member)
      component.push(member)
      if (member === id) break
    }
    components.push(component)
  }
  for (const id of input) if (!index.has(id)) visit(id)
  const componentOf = new Map(components.flatMap((component, componentIndex) =>
    component.map((id) => [id, componentIndex] as const)))
  const outgoing = new Map<number, Set<number>>()
  const indegree = new Map<number, number>()
  for (const id of input) {
    const from = componentOf.get(id)!
    for (const next of corpus.byId.get(id)?.outgoing ?? []) {
      if (!allowed.has(next)) continue
      const to = componentOf.get(next)!
      if (from === to) continue
      const targets = outgoing.get(from) ?? new Set<number>()
      if (targets.has(to)) continue
      targets.add(to)
      outgoing.set(from, targets)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
  }
  const position = new Map(input.map((id, order) => [id, order]))
  const ready = components.map((_, component) => component)
    .filter((component) => !indegree.has(component))
  const depths = new Map(ready.map((component) => [
    component, Math.max(0, components[component]!.length - 1),
  ]))
  const ids: string[] = []
  let depth = 0
  while (ready.length > 0) {
    ready.sort((left, right) =>
      Math.min(...components[left]!.map((id) =>
        position.get(id) ?? LAST))
      - Math.min(...components[right]!.map((id) =>
        position.get(id) ?? LAST)))
    const component = ready.shift()!
    const currentDepth = depths.get(component) ?? 0
    depth = Math.max(depth, currentDepth)
    ids.push(...components[component]!.sort((left, right) =>
      (position.get(left) ?? LAST)
      - (position.get(right) ?? LAST)
      || compare(left, right)))
    for (const next of outgoing.get(component) ?? []) {
      depths.set(next, Math.max(
        depths.get(next) ?? 0,
        currentDepth + 1 + Math.max(0, components[next]!.length - 1),
      ))
      const remaining = (indegree.get(next) ?? 0) - 1
      if (remaining > 0) indegree.set(next, remaining)
      else {
        indegree.delete(next)
        ready.push(next)
      }
    }
  }
  return { ids: ids.length === input.length ? ids : [...input], depth }
}

function rootPath(
  corpus: Corpus, target: string, seedById: ReadonlyMap<string, Seed>,
  forbidden: ReadonlySet<string>,
): string[] | null {
  const next = new Map<string, string>()
  const depth = new Map([[target, 0]])
  const queue = [target]
  const roots: string[] = []
  for (let cursor = 0; cursor < queue.length && queue.length < 512; cursor += 1) {
    const id = queue[cursor]!
    const node = corpus.byId.get(id)
    const distance = depth.get(id) ?? 0
    if (id !== target && node?.incoming.length === 0) roots.push(id)
    if (!node || distance >= 16) continue
    for (const parent of node.incoming) {
      if (depth.has(parent)) continue
      depth.set(parent, distance + 1)
      next.set(parent, id)
      queue.push(parent)
    }
  }
  const route = (root: string): string[] => {
    const result = [root]
    while (result.at(-1) !== target) result.push(next.get(result.at(-1)!)!)
    return result
  }
  const choices = roots.flatMap((root) => {
    const ids = route(root)
    if (ids.slice(0, -1).some((id) => forbidden.has(id))) return []
    return [{
      ids,
      concepts: new Set(ids.flatMap((id) =>
        seedById.get(id)?.concepts ?? [])).size,
      terms: new Set(ids.flatMap((id) =>
        seedById.get(id)?.direct ?? [])).size,
    }]
  })
  return choices.sort((left, right) =>
    left.ids.length - right.ids.length
    || right.concepts - left.concepts
    || right.terms - left.terms
    || (seedById.get(right.ids[0]!)?.ranked.score ?? 0)
      - (seedById.get(left.ids[0]!)?.ranked.score ?? 0)
    || compare(left.ids[0]!, right.ids[0]!))[0]?.ids ?? null
}

function connectorSelection(
  corpus: Corpus, seeds: readonly Seed[], query: Vocabulary,
): Selection | null {
  const seedById = new Map(seeds.map((seed) => [seed.node.id, seed]))
  const byId = corpus.byId
  const hubs = corpus.nodes.filter((hub) =>
    executable(hub) && hub.incoming.length > 0 && hub.outgoing.length > 0)
  const candidates = hubs.flatMap((hub) =>
    (corpus.files.get(hub.file) ?? []).filter((registry) =>
      executable(registry) && registry.id !== hub.id
      && registry.incoming.length >= 2)
      .flatMap((registry) => {
        const pairs = registry.incoming.flatMap((registrarId) => {
          const registrar = byId.get(registrarId)
          if (!executable(registrar) || !registrar.owner) return []
          const consumers = (corpus.members.get(registrar.owner) ?? [])
            .filter((id) => id !== registrarId && registrar.outgoing.includes(id)
              && executable(byId.get(id)))
          return consumers.length === 1
            ? [{ registrarId, consumerId: consumers[0]! }] : []
        })
        const registrars = [...new Set(pairs.map((pair) => pair.registrarId))]
        const consumers = [...new Set(pairs.map((pair) => pair.consumerId))]
        const role = (id: string): string => {
          const node = byId.get(id)!
          return `${node.kind}\0${text(node.attributes, 'label').replace(/^\./u, '')}`
        }
        if (registrars.length < 2 || registrars.length !== consumers.length
          || new Set(registrars.map(role)).size !== 1
          || new Set(consumers.map(role)).size !== 1
          || role(registrars[0]!) === role(consumers[0]!)) return []
        const direct = consumers.filter((id) => hub.outgoing.includes(id)).length
        if (direct * 2 >= consumers.length) return []
        const entry = rootPath(
          corpus, hub.id, seedById, new Set([...registrars, ...consumers]),
        )
        return entry
          ? [{ hub, consumers, entry }] : []
      }))
    .sort((left, right) =>
      Number(seedById.has(right.hub.id)) - Number(seedById.has(left.hub.id))
      || right.hub.incoming.length - left.hub.incoming.length
      || right.consumers.length - left.consumers.length
      || compare(left.hub.id, right.hub.id))
  const candidate = candidates[0]
  if (!candidate) return null
  const branches = candidate.consumers.map((consumerId) => {
    const consumer = byId.get(consumerId)!
    const services = consumer.outgoing.filter((id) => executable(byId.get(id)))
    const serviceId = [...services].sort((left, right) =>
      Number(!!path(corpus, right, candidate.hub.id))
      - Number(!!path(corpus, left, candidate.hub.id))
      || Number(byId.get(right)?.file !== consumer.file)
      - Number(byId.get(left)?.file !== consumer.file)
      || (seedById.get(right)?.ranked.score ?? 0)
      - (seedById.get(left)?.ranked.score ?? 0)
      || compare(left, right))[0]
    return {
      consumerId, serviceId,
      direct: candidate.hub.outgoing.includes(consumerId),
      returns: !!serviceId && !!path(corpus, serviceId, candidate.hub.id),
    }
  }).sort((left, right) =>
    Number(right.direct) - Number(left.direct)
    || Number(right.returns) - Number(left.returns)
    || (byId.get(left.serviceId ?? '')?.outgoing.length
      ?? LAST)
      - (byId.get(right.serviceId ?? '')?.outgoing.length
        ?? LAST)
    || (seedById.get(right.consumerId)?.ranked.score ?? 0)
      - (seedById.get(left.consumerId)?.ranked.score ?? 0)
    || compare(left.consumerId, right.consumerId))
  const ids: string[] = []
  const files = new Set<string>()
  const append = (id?: string): boolean => {
    if (!id || ids.includes(id)) return true
    const node = byId.get(id)
    if (!executable(node)) return true
    if (ids.length >= SNIPPET_CAP
      || (node.file && !files.has(node.file) && files.size >= FILE_CAP)) return false
    ids.push(id)
    if (node.file) files.add(node.file)
    return true
  }
  for (const id of candidate.entry) append(id)
  const direct = branches.find((branch) => branch.direct) ?? branches[0]
  if (!query.expand) {
    append(direct?.consumerId)
  } else {
    const terminal = branches.filter((branch) => !branch.returns)
    for (const branch of branches) {
      if (branch.returns
        || (!!branch.serviceId
          && (directTerms(byId.get(branch.serviceId)!, query, true).length > 0
            || (query.concepts.length > 1 && terminal.length === 1
              && query.scopes.every((scope) => scope.restricts))))) {
        append(branch.consumerId)
      }
      if (branch.returns) append(branch.serviceId)
    }
  }
  let sideBranch: string | undefined
  for (const scope of query.scopes.filter((scope) => !scope.restricts)) {
    const side = corpus.nodes.filter((node) =>
      executable(node) && !ids.includes(node.id) && inScope(node, scope)
      && node.incoming.some((id) => ids.includes(id)))
      .sort((left, right) =>
        (seedById.get(right.id)?.ranked.score ?? 0)
        - (seedById.get(left.id)?.ranked.score ?? 0)
        || compare(left.id, right.id))[0]
    if (!side) continue
    const parent = Math.max(...side.incoming.map((id) => ids.indexOf(id)))
    const length = ids.length
    if (parent < 0 || !append(side.id) || ids.length === length) continue
    ids.pop()
    ids.splice(parent + 1, 0, side.id)
    sideBranch = side.id
    break
  }
  return {
    ids, flow: true, complete: true, structuralRequired: true,
    ...sideBranch ? { branch: sideBranch } : {},
  }
}

function causalSelection(
  corpus: Corpus, seeds: readonly Seed[], query: Vocabulary,
): Selection | null {
  if (seeds.length === 0) return null
  const symbolScopes = query.scopes.filter((scope) => !scope.restricts)
  const scopedTerms = new Set(symbolScopes.flatMap((scope) => scope.tokens))
  const selected = (symbolScopes.length > 0
    ? seeds.filter((seed) =>
      symbolScopes.some((scope) => inScope(seed.node, scope))
      || seed.direct.some((term) => !scopedTerms.has(term)))
    : seeds).slice(0, 32)
  const ids = new Set(selected.map((seed) => seed.node.id))
  for (const node of corpus.nodes) {
    if (!executable(node)) continue
    const children = node.outgoing.filter((id) => ids.has(id))
    if (children.length >= 2) ids.add(node.id)
  }
  const filtered = [...ids].filter((id) => executable(corpus.byId.get(id)))
  const files = new Set<string>()
  const bounded = causalOrder(corpus, filtered).ids.filter((id) => {
    const node = corpus.byId.get(id)!
    if (files.size >= FILE_CAP && node.file && !files.has(node.file)) return false
    if (files.size < FILE_CAP && node.file) files.add(node.file)
    return true
  }).slice(0, SNIPPET_CAP)
  const retained = new Set(bounded)
  const edges = bounded.reduce((count, id) =>
    count + corpus.byId.get(id)!.outgoing.filter((to) => retained.has(to)).length, 0)
  const depth = causalOrder(corpus, bounded).depth
  const ordered = [...new Set(query.scopes.flatMap((scope) =>
    selected.filter((seed) => inScope(seed.node, scope))))]
  const reachable = ordered.some((from, index) =>
    ordered.slice(index + 1).some((to) =>
      !!path(corpus, from.node.id, to.node.id)))
  if (edges === 0 && (!(query.scopes.length > 1
    || query.terms.filter((term) => /^\d+$/.test(term)).length > 1)
    || (query.limits.length === 0 && !reachable))) return {
    ids: [], flow: false, complete: false,
    structuralRequired: true,
  }
  if (depth < 2 && edges >= 3 && files.size <= 1) return {
    ids: [], flow: false, complete: false,
    structuralRequired: true,
  }
  const conceptCoverage = new Set(selected
    .filter((seed) => retained.has(seed.node.id))
    .flatMap((seed) => seed.concepts))
  return {
    ids: bounded,
    flow: bounded.length > 1,
    complete: query.concepts.every((concept, index) =>
      concept.size === 0 || conceptCoverage.has(index)),
    structuralRequired: true,
  }
}

function selectStructure(
  corpus: Corpus, scored: readonly Scored[], query: Vocabulary,
): Selection | null {
  if (!query.structural || query.terms[0] === 'where'
    || (query.scopes.some((scope) => !scope.restricts) && !query.expand)
    || query.limits.some((scope) => scope.subject.includes('/'))) return null
  if (!query.expand) {
    const hits = scored.map(({ node }) =>
      [node, directTerms(node, query)] as const)
    const coverable = new Set(hits.flatMap(([, terms]) => terms))
    if (hits.some(([node, direct]) =>
      direct.length * 5 >= coverable.size * 3
        && direct.some((term) =>
          hits.filter(([, terms]) => terms.includes(term)).length <= 2)
        && !node.incoming.concat(node.outgoing).some((id) => {
          const adjacent = corpus.byId.get(id)
          return !!adjacent && directTerms(adjacent, query)
            .some((term) => coverable.has(term) && !direct.includes(term))
        }))) return null
  }
  const seeds = scored.flatMap((item): Seed[] => {
    if (!executable(item.node)
      || (item.node.domain !== 'production'
        && item.node.domain !== 'unknown')) return []
    const direct = directTerms(item.node, query)
    if (direct.length === 0) return []
    return [{
      ...item, direct,
      concepts: query.concepts.flatMap((concept, index) =>
        direct.some((term) => concept.has(term)) ? [index] : []),
    }]
  }).sort((left, right) =>
    Number(right.node.incoming.length + right.node.outgoing.length > 0)
    - Number(left.node.incoming.length + left.node.outgoing.length > 0)
    || right.direct.length - left.direct.length
    || compareScored(left, right))
  return connectorSelection(corpus, seeds, query)
    ?? causalSelection(corpus, seeds, query)
}

function fallbackSelection(
  index: ReadyQueryIndex, corpus: Corpus, scored: readonly Scored[],
  query: Vocabulary,
): Selection {
  const ids: string[] = []
  const files = new Set<string>()
  const covered = new Set<string>()
  const add = (item: Scored): void => {
    if (ids.includes(item.node.id)) return
    if (item.node.file && !files.has(item.node.file)
      && files.size >= FILE_CAP) return
    ids.push(item.node.id)
    if (item.node.file) files.add(item.node.file)
    for (const term of item.ranked.matchedTerms) covered.add(term)
  }
  if (query.limits.some((scope) => scope.subject.includes('/'))) {
    for (const scope of query.limits.filter((item) =>
      item.subject.includes('/'))) {
      const matching = scored.filter((item) => inScope(item.node, scope))
      const file = matching.find((item) => item.node.kind === 'file')
      const symbol = matching.find((item) => item.node.kind !== 'file'
        && (!file || index.graph.edgesBetween(file.node.id, item.node.id)
          .some(({ attributes }) => text(attributes, 'relation') === 'contains')))
      if (file) add(file)
      if (symbol) add(symbol)
    }
  } else if (query.concepts.length > 1) {
    for (const concept of query.concepts) {
      const next = scored.filter((item) =>
        item.ranked.matchedTerms.some((term) => concept.has(term)))
        .sort((left, right) =>
          Number(!files.has(right.node.file)) - Number(!files.has(left.node.file))
          || compareScored(left, right))[0]
      if (next) add(next)
    }
  } else {
    const initial = scored[0]
    const first = initial && (scored.find((item) =>
      item.node.file === initial.node.file
      && initial.node.outgoing.includes(item.node.id)
      && initial.ranked.matchedTerms.every((term) =>
        item.ranked.matchedTerms.includes(term))
      && directTerms(item.node, query, true).length
        >= directTerms(initial.node, query, true).length) ?? initial)
    if (first) add(first)
    while (ids.length < SNIPPET_CAP) {
      const next = scored.filter((item) => !ids.includes(item.node.id)
        && (files.has(item.node.file) || files.size < FILE_CAP))
        .sort((left, right) => {
          const connection = (item: Scored): number => Number(ids.some((id) =>
            index.graph.edgesBetween(id, item.node.id).some(({ attributes }) =>
              CAUSAL.has(text(attributes, 'relation')))))
          const novelty = (item: Scored): number =>
            item.ranked.matchedTerms.filter((term) => !covered.has(term)).length
          return novelty(right) - novelty(left)
            || connection(right) - connection(left)
            || left.ranked.firstMatch - right.ranked.firstMatch
            || compareScored(left, right)
      })[0]
      if (!next) break
      const novel = next.ranked.matchedTerms.some((term) => !covered.has(term))
      const connected = directTerms(next.node, query).length > 0 && ids.some((id) =>
        index.graph.edgesBetween(id, next.node.id).some(({ attributes }) =>
          CAUSAL.has(text(attributes, 'relation'))))
      if (!novel && !connected) break
      add(next)
    }
  }
  const ordered = causalOrder(corpus, ids).ids
  return {
    ids: ordered, flow: false, complete: true, structuralRequired: false,
  }
}

function unsupportedCandidates(
  index: ReadyQueryIndex, query: Vocabulary,
): UnsupportedCandidate[] {
  return index.unsupported_sources.flatMap((source): UnsupportedCandidate[] => {
    const extension = source.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    const domain = classifySourceDomain(source.path, index.root_path)
    if (!UNSUPPORTED.test(extension)
      || isPollutedSourcePath(source.path, index.root_path)
      || (domain !== 'production' && domain !== 'unknown')) return []
    const pathTokens = new Set(meaningful(source.path))
    const basename = new Set(meaningful(source.path.split('/').at(-1) ?? source.path))
    const matched = query.terms.filter((term) =>
      !term.includes('_') && !term.includes('-') && pathTokens.has(term))
    const weights = new Map(matched.map((term) => [term, basename.has(term) ? 4 : 1]))
    const scope = query.scopes.some((candidate) =>
      candidate.tokens.every((term) => pathTokens.has(term))
      && tokens(source.path).join('').includes(candidate.compact))
    if (!scope && (matched.length === 0
      || matched.every((term) => term.length < 4))) return []
    return [{
      path: source.path, terms: matched, weights,
      first: matched.reduce((first, term) =>
        Math.min(first, query.positions.get(term) ?? LAST),
      LAST),
      score: matched.reduce((total, term) =>
        total + term.length ** 2 * (weights.get(term) ?? 1) * 100,
      scope ? 1_000_000 : 0),
    }]
  }).sort((left, right) =>
    right.score - left.score || left.first - right.first
    || compare(left.path, right.path))
}

function unsupportedBoundaries(
  candidates: readonly UnsupportedCandidate[],
): EvidenceBoundary[] {
  const selected: UnsupportedCandidate[] = []
  const covered = new Set<string>()
  const remaining = [...candidates]
  while (remaining.length > 0 && selected.length < 4) {
    remaining.sort((left, right) => {
      const novelty = (candidate: UnsupportedCandidate): number =>
        candidate.terms.filter((term) => !covered.has(term))
          .reduce((total, term) =>
            total + term.length ** 2 * (candidate.weights.get(term) ?? 1), 0)
      return novelty(right) - novelty(left)
        || right.score - left.score || compare(left.path, right.path)
    })
    const next = remaining.shift()!
    if (selected.length > 0
      && next.terms.every((term) => covered.has(term))
      && next.score * 3 < selected[0]!.score) break
    selected.push(next)
    for (const term of next.terms) covered.add(term)
  }
  const boundaries: EvidenceBoundary[] = selected
    .map((candidate): EvidenceBoundary => ({
      kind: 'unsupported', subject: candidate.path,
    }))
    .sort((left, right) => compare(left.subject, right.subject))
  return selected.length >= 4 && remaining.length > 0
    ? [...boundaries, { kind: 'truncated', subject: 'unsupported sources' }]
    : boundaries
}

export function rankQueryAnchors(
  index: ReadyQueryIndex, request: NormalizedRetrieveRequest,
): RankQueryResult {
  const corpus = buildCorpus(index)
  const query = vocabulary(request.question)
  const active = (scope: Scope): boolean => !scope.restricts
    || scope.subject.includes('/') || corpus.nodes.some((node) => {
      const prefix = scope.tokens.filter((term) => !/^\d+$/.test(term))
      return prefix.every((term) => node.tokens.has(term))
        && [...node.tokens].some((term) => /^\d+$/.test(term))
    })
  for (const scope of query.scopes.filter((scope) => !active(scope))) {
    const outside = new Set(tokens(request.question.replaceAll(scope.subject, '')))
    query.terms = query.terms.filter((term) =>
      !/^\d+$/.test(term) || !scope.tokens.includes(term) || outside.has(term))
  }
  query.scopes = query.scopes.filter(active)
  query.limits = query.scopes.filter((scope) => scope.restricts)
  const unsupported = unsupportedCandidates(index, query)
  const unsupportedFacts = unsupportedBoundaries(unsupported)
  const missing = query.scopes.flatMap((scope): EvidenceBoundary[] => {
    const graphMatches = corpus.nodes.filter((node) => inScope(node, scope))
    if (graphMatches.some((node) => node.eligible)
      || unsupported.some((candidate) =>
        tokens(candidate.path).join('').includes(scope.compact))) return []
    return [{
      kind: graphMatches.length > 0 ? 'unavailable' : 'missing',
      subject: scope.subject,
    }]
  })
  const scored = scoredNodes(corpus, query)
  const available = query.scopes.filter((scope) =>
    corpus.nodes.some((node) => node.eligible && inScope(node, scope)))
  const limits = query.limits.filter((scope) =>
    available.includes(scope))
  const scopedTerms = new Set(available.flatMap((scope) => scope.tokens))
  const allScopedTerms = new Set(query.scopes.flatMap((scope) => scope.tokens))
  const unscopedTerms = new Set(query.terms.filter((term) => !allScopedTerms.has(term)))
  const pool = query.limits.length > 0
    ? limits.length === 0 ? [] : scored.filter(({ node }) =>
      limits.some((scope) => inScope(node, scope)))
    : query.scopes.length === 0 ? scored
      : available.length === 0
        ? scored.filter(({ ranked }) =>
          ranked.matchedTerms.some((term) => unscopedTerms.has(term)))
        : scored.filter(({ node, ranked }) =>
          available.some((scope) => inScope(node, scope))
          || ranked.matchedTerms.some((term) => !scopedTerms.has(term)))
  const structural = selectStructure(corpus, pool, query)
  const selection = structural ?? fallbackSelection(
    index, corpus, pool, query,
  )
  const anchors = selection.ids.flatMap((id, ordinal): RankedQueryNode[] => {
    const existing = pool.find((candidate) => candidate.node.id === id)?.ranked
    if (existing) return [existing]
    const node = corpus.byId.get(id)
    if (!node?.eligible) return []
    const matchedTerms = directTerms(node, query)
    return [{
      id, attributes: node.attributes,
      score: Math.max(0, (pool[0]?.ranked.score ?? 0) - ordinal),
      matchedTerms,
      firstMatch: matchedTerms.reduce((first, term) =>
        Math.min(first, query.positions.get(term) ?? LAST),
      LAST),
    }]
  })
  const selected = new Set(anchors.map((anchor) => anchor.id))
  const selectedFiles = new Set(anchors.map((anchor) =>
    text(anchor.attributes, 'source_file')))
  const truncated = pool.some(({ node }) => !selected.has(node.id))
    && (anchors.length >= SNIPPET_CAP
      || selectedFiles.size >= FILE_CAP)
    ? [{ kind: 'truncated', subject: 'query anchors' } satisfies EvidenceBoundary]
    : []
  const boundaries = anchors.length === 0
    && unsupportedFacts.length === 0 && missing.length === 0
    ? [{ kind: 'missing', subject: request.question } satisfies EvidenceBoundary]
    : [...unsupportedFacts, ...missing, ...truncated]
  return {
    anchors, boundaries,
    queryTerms: query.terms, flow: selection.flow, branch: selection.branch ?? '',
    priorityAnchorIds: selection.ids,
    structuralRequired: selection.structuralRequired,
    structuralCoverageComplete: selection.complete
      && (!selection.structuralRequired || missing.length === 0),
  }
}
