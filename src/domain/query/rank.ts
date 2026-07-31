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
  'a actual an and any applicabl are as at be by bas being can do does exist final for from get gett handl explain how in initial is it its me new of on operat or specific tell that the then through to trace what when which with work you'.split(' '),
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
  pathTokens: ReadonlySet<string>; ins: string[]; outs: string[]
  owner?: string; eligible: boolean; defined: boolean
}
interface Corpus {
  nodes: readonly Node[]; byId: ReadonlyMap<string, Node>
  members: ReadonlyMap<string, readonly string[]>
  files: ReadonlyMap<string, readonly Node[]>
  freq: ReadonlyMap<string, number>; docs: number
}
interface Scope {
  subject: string; tokens: string[]; compact: string; first: number
  hard: boolean
}
interface Vocabulary {
  terms: string[]; pos: ReadonlyMap<string, number>
  scopes: Scope[]; limits: Scope[]; parts: readonly ReadonlySet<string>[]
  mentions: ReadonlySet<string>
  domains: ReadonlySet<SourceDomain>
  structural: boolean; expand: boolean; sequential: boolean
}
interface Scored { n: Node; rank: RankedQueryNode }
interface Seed extends Scored { hits: string[]; parts: number[] }
interface Selection {
  ids: string[]; flow: boolean; complete: boolean
  structuralRequired: boolean; branch?: string[]
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

function words(value: string): string[] {
  return tokens(value).filter((token) => !STOP.has(token))
}

function matches(values: ReadonlySet<string>, t: string): boolean {
  if (values.has(t)) return true
  if (t.length < 3) return false
  const singular = t.length >= 4 && t.endsWith('s') && !t.endsWith('ss')
    ? t.slice(0, -1) : `${t}s`
  const bare = t.endsWith('e') ? t.slice(0, -1) : `${t}e`
  for (const form of [t, singular, bare]) {
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

function field(value: string, weight: number): Field | null {
  const lexical = tokens(value)
  return lexical.length === 0 ? null : {
    compact: lexical.join(''), tokens: new Set(lexical), weight,
  }
}

function buildCorpus(index: ReadyQueryIndex): Corpus {
  const cached = corpusCache.get(index)?.deref()
  if (cached) return cached
  const nodes: Node[] = []
  const paths = new Map<string, Field | null>()
  for (const [id, attributes] of index.graph.nodeEntries()) {
    const file = text(attributes, 'source_file')
    const kind = text(attributes, 'node_kind')
    // Shared execution channels are traversal infrastructure for retrieval v2.
    // Keeping them out of the v1 lexical corpus prevents their labels from
    // changing document frequency and therefore existing symbol ranking.
    if (kind === 'channel') continue
    if (!paths.has(file)) paths.set(file, field(file, 7))
    const pathField = paths.get(file) ?? null
    const fields = [
      field(text(attributes, 'label'), 12),
      field(text(attributes, 'qualified_name'), 12),
      field(`${text(attributes, 'framework')} ${
        text(attributes, 'framework_role')}`, 5),
      field(JSON.stringify(attributes.framework_metadata) ?? '', 5),
      field(kind, 3),
      pathField,
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
      pathTokens: pathField?.tokens ?? new Set(),
      ins: [], outs: [], eligible,
      defined: kind === 'file'
        || JSON.stringify(attributes.declaration_range)
          !== JSON.stringify(attributes.definition_range),
    })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const members = new Map<string, string[]>()
  for (const [from, to, attributes] of index.graph.edgeEntries()) {
    const source = byId.get(from)
    const target = byId.get(to)
    const relation = text(attributes, 'relation')
    if (source && target && CAUSAL.has(relation)
      && source.kind !== 'file' && target.kind !== 'file') {
      source.outs.push(to)
      target.ins.push(from)
    }
    if (source?.kind === 'class' && target
      && (relation === 'contains' || relation === 'method')) {
      target.owner = from
      const owned = members.get(from) ?? []
      owned.push(to)
      members.set(from, owned)
    }
  }
  for (const n of nodes) {
    n.ins = [...new Set(n.ins)].sort(compare)
    n.outs = [...new Set(n.outs)].sort(compare)
  }
  for (const [owner, owned] of members) {
    members.set(owner, [...new Set(owned)].sort(compare))
  }
  const docs = new Map<string, Set<string>>()
  const files = new Map<string, Node[]>()
  for (const n of nodes) {
    const siblings = files.get(n.file) ?? []
    siblings.push(n)
    files.set(n.file, siblings)
    const document = docs.get(n.file || n.id) ?? new Set<string>()
    for (const field of n.fields) for (const token of field.tokens) document.add(token)
    docs.set(n.file || n.id, document)
  }
  const freq = new Map<string, number>()
  for (const document of docs.values()) {
    for (const token of document) {
      freq.set(token, (freq.get(token) ?? 0) + 1)
    }
  }
  const c = {
    nodes, byId, members, files, freq, docs: docs.size,
  } satisfies Corpus
  corpusCache.set(index, new WeakRef(c))
  return c
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
  for (const [pattern, hard] of patterns) {
    for (const match of question.matchAll(pattern)) {
      const subject = (match[1] ?? match[0]).trim()
      if (subject === match[0] && /^[A-Z]+$/u.test(subject)) continue
      const lexical = tokens(subject)
      const compact = lexical.join('')
      if (!compact || seen.has(compact)) continue
      seen.add(compact)
      result.push({
        subject, tokens: lexical, compact,
        first: match.index ?? LAST, hard,
      })
    }
  }
  const qualified = result.filter((s) =>
    !s.hard && s.subject.includes('.'))
  return result.filter((s) => !qualified.some((parent) =>
    parent !== s
    && s.first > parent.first
    && s.first <= parent.first + parent.subject.length + 1
    && parent.subject.split('.').includes(s.subject)))
    .sort((a, b) =>
      a.first - b.first || compare(a.subject, b.subject))
}

function vocabulary(question: string): Vocabulary {
  const task = question.replace(/\.\s+(?:cite|use|report)\b[\s\S]*$/iu, '')
  const raw = tokens(task)
  const terms: string[] = []
  const pos = new Map<string, number>()
  for (const [position, t] of raw.entries()) {
    if (!STOP.has(t) && !pos.has(t)) {
      terms.push(t)
      pos.set(t, position)
    }
  }
  const lower = task.toLowerCase()
  for (const relation of RELATIONS) {
    const variants = [relation, relation.replaceAll('_', ' ')]
    const found = variants.map((variant) => lower.indexOf(variant))
      .filter((position) => position >= 0)
    if (found.length > 0 && !pos.has(relation)) {
      terms.push(relation)
      pos.set(relation, Math.min(...found))
    }
  }
  const explicit = scopes(task)
  const clauses = task
    .split(
      /[,;:\u2013\u2014]+|[!?]+|\.(?=\s+[A-Z])|\b(?:[Aa][Nn][Dd]\s+)?[Tt][Hh][Ee][Nn]\b/u,
    )
    .map(words).filter((part) => part.length > 0)
  const parts = (clauses.length > 0 ? clauses : [terms])
    .map((part) => new Set(part))
  const connector = raw.findIndex((t, index) =>
    index > 0 && index < raw.length - 1
    && (t === 'through' || t === 'until'))
  const directed = (raw.includes('from')
    && raw.some((t) => t === 'to' || t === 'through'))
    || connector >= 0
    || raw.some((t, index) =>
      t === 'end' && raw[index + 1] === 'to' && raw[index + 2] === 'end')
  const from = raw.indexOf('from')
  const to = raw.indexOf('to', from + 1)
  const parallel = from >= 0 && to > from && raw.includes('and')
  const explainsProcess = raw.includes('how') && terms.length > 1
    && explicit.every((s) => s.hard)
  const structural = directed || parts.length > 1
    || explainsProcess
    || terms.some((t) => [
      'flow', 'handoff', 'journey', 'lifecycl', 'orchestrat',
      'pipelin', 'process', 'queue', 'sequenc', 'stag',
    ].includes(t))
  const expand = directed || parts.length > 1
    || (terms.some((t) => t === 'stag' || t === 'stage')
      && terms.some((t) =>
      ['job', 'jobs', 'queue', 'enqueu', 'orchestrat'].includes(t)))
  const domains = new Set<SourceDomain>(Object.entries(DOMAIN_TERMS)
    .filter(([, variants]) =>
      variants.some((variant) => terms.includes(variant)))
    .map(([domain]) => domain as SourceDomain))
  return {
    terms, pos, scopes: explicit,
    limits: explicit.filter((s) => s.hard),
    parts, mentions: new Set(task.split(/[^A-Za-z0-9_$]+/u)), domains,
    structural, expand,
    sequential: connector >= 0 || raw.includes('then') || (directed && !parallel),
  }
}

function inScope(n: Node, s: Scope): boolean {
  return s.tokens.every((token) => n.tokens.has(token))
    && n.fields.some((field) => field.compact.includes(s.compact))
}

function rarity(c: Corpus, t: string): number {
  const seen = c.freq.get(t) ?? 0
  return Math.max(1, Math.round(
    (1 + Math.log2((c.docs + 1) / (seen + 1))) * 64,
  ))
}

function exactLabel(n: Node, q: Vocabulary): boolean {
  const label = text(n.attributes, 'label')
  const identifier = label.replace(/^\./u, '').replace(/\(\)$/u, '')
  return (label.endsWith('()') || /[A-Z_$\d.:]/u.test(identifier))
    && words(identifier).length > 0 && q.mentions.has(identifier)
}

function termsOf(n: Node, q: Vocabulary, semantic = false): string[] {
  return q.terms.filter((t) => n.fields.some((field) =>
    (!semantic || field.weight !== 7) && matches(field.tokens, t)))
}

function score(
  c: Corpus, n: Node, q: Vocabulary,
): RankedQueryNode | null {
  const hits = termsOf(n, q)
  const context = q.terms.filter((t) => !hits.includes(t)
    && [...n.ins, ...n.outs].some((id) => {
      const adjacent = c.byId.get(id)
      return !!adjacent?.eligible && matches(adjacent.tokens, t)
    }))
  if (hits.length === 0 && context.length === 0
    && !q.scopes.some((s) => inScope(n, s))) return null
  let value = n.domain === 'production' ? 500
    : n.domain === 'test' ? -250
      : n.domain === 'unknown' ? 0 : -500
  for (const t of hits) {
    const weight = Math.max(0, ...n.fields
      .filter((field) => matches(field.tokens, t)).map((field) => field.weight))
    value += rarity(c, t) * weight
    if (n.fields.some((field) =>
      field.weight !== 7 && matches(field.tokens, t))) {
      value += rarity(c, t) * 12
    }
    if (matches(n.pathTokens, t)) value += rarity(c, t) * 7
  }
  for (const t of context) value += rarity(c, t) * 5
  for (const s of q.scopes.filter((s) => !s.hard)) {
    if (n.fields.some((field) => field.compact === s.compact)) value += 2_000_000
    else if (inScope(n, s)) value += 1_000_000
  }
  if (exactLabel(n, q)) value += 2_000_000
  const firstMatch = hits.reduce((first, t) =>
    Math.min(first, q.pos.get(t) ?? LAST),
  LAST)
  return {
    id: n.id, attributes: n.attributes, score: value,
    matchedTerms: [...hits, ...context], firstMatch,
  }
}

function byRank(a: Scored, b: Scored): number {
  return b.rank.score - a.rank.score
    || a.rank.firstMatch - b.rank.firstMatch
    || b.n.outs.length - a.n.outs.length
    || compare(a.n.file, b.n.file)
    || compare(a.n.id, b.n.id)
}

function inDomain(n: Node, q: Vocabulary): boolean {
  return q.domains.size > 0
    ? q.domains.has(n.domain)
    : n.domain === 'production' || n.domain === 'unknown'
}

function scoredNodes(
  c: Corpus, q: Vocabulary, keep: (n: Node) => boolean,
): Scored[] {
  const items = c.nodes.flatMap((n): Scored[] => {
    if (!n.eligible || !keep(n)
      || (q.limits.length > 0
        && !q.limits.some((s) => inScope(n, s)))) return []
    if (n.kind === 'file' && !q.terms.includes('imports_from')
      && !q.limits.some((s) =>
        s.subject.includes('/') && inScope(n, s))) return []
    if ((!n.defined || n.kind === 'interface' || n.kind === 'type-alias')
      && !q.terms.some((t) => tokens(n.kind).includes(t))
      && !q.terms.some((t) => t === 'defin' || t === 'declar')
      && !q.scopes.some((s) => inScope(n, s))
      && !exactLabel(n, q)) return []
    if (!inDomain(n, q) && !q.scopes.some((s) => inScope(n, s))) return []
    const rank = score(c, n, q)
    if (!rank) return []
    return [{ n, rank }]
  }).sort(byRank)
  if (q.parts.length > 1 || q.scopes.length > 0) return items
  const locator = q.terms[0] === 'where'
  const byFile = new Map<string, Scored[]>()
  for (const item of items) {
    const current = byFile.get(item.n.file || item.n.id) ?? []
    current.push(item)
    byFile.set(item.n.file || item.n.id, current)
  }
  return [...byFile.values()].flatMap((entries) =>
    entries.sort((a, b) => {
      if (locator) return byRank(a, b)
      const ids = new Set(entries.map((entry) => entry.n.id))
      return b.n.outs.filter((id) => ids.has(id)).length
        - a.n.outs.filter((id) => ids.has(id)).length
        || byRank(a, b)
    }).slice(0, 2)).sort(byRank)
}

function usable(n: Node | undefined, q: Vocabulary): n is Node {
  return !!n?.eligible && n.kind !== 'file' && n.kind !== 'class'
    && (inDomain(n, q) || n.domain === 'production' || n.domain === 'unknown')
}

function path(
  c: Corpus, from: string, to: string, q: Vocabulary, backwards = false,
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
      ? c.byId.get(id)?.ins ?? []
      : c.byId.get(id)?.outs ?? []
    for (const next of adjacent) {
      if (depth.has(next) || !usable(c.byId.get(next), q)) continue
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

function toposort(c: Corpus, input: readonly string[]): {
  ids: string[]; depth: number
} {
  const allowed = new Set(input)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  const groups: string[][] = []
  let ordinal = 0
  const visit = (id: string): void => {
    index.set(id, ordinal)
    low.set(id, ordinal++)
    stack.push(id)
    active.add(id)
    for (const next of c.byId.get(id)?.outs ?? []) {
      if (!allowed.has(next)) continue
      if (!index.has(next)) {
        visit(next)
        low.set(id, Math.min(low.get(id)!, low.get(next)!))
      } else if (active.has(next)) {
        low.set(id, Math.min(low.get(id)!, index.get(next)!))
      }
    }
    if (low.get(id) !== index.get(id)) return
    const group: string[] = []
    while (stack.length > 0) {
      const member = stack.pop()!
      active.delete(member)
      group.push(member)
      if (member === id) break
    }
    groups.push(group)
  }
  for (const id of input) if (!index.has(id)) visit(id)
  const groupOf = new Map(groups.flatMap((group, groupIndex) =>
    group.map((id) => [id, groupIndex] as const)))
  const outs = new Map<number, Set<number>>()
  const indegree = new Map<number, number>()
  for (const id of input) {
    const from = groupOf.get(id)!
    for (const next of c.byId.get(id)?.outs ?? []) {
      if (!allowed.has(next)) continue
      const to = groupOf.get(next)!
      if (from === to) continue
      const targets = outs.get(from) ?? new Set<number>()
      if (targets.has(to)) continue
      targets.add(to)
      outs.set(from, targets)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
  }
  const pos = new Map(input.map((id, order) => [id, order]))
  const ready = groups.map((_, group) => group)
    .filter((group) => !indegree.has(group))
  const depths = new Map(ready.map((group) => [
    group, Math.max(0, groups[group]!.length - 1),
  ]))
  const ids: string[] = []
  let depth = 0
  while (ready.length > 0) {
    ready.sort((a, b) =>
      Math.min(...groups[a]!.map((id) =>
        pos.get(id) ?? LAST))
      - Math.min(...groups[b]!.map((id) =>
        pos.get(id) ?? LAST)))
    const group = ready.shift()!
    const level = depths.get(group) ?? 0
    depth = Math.max(depth, level)
    ids.push(...groups[group]!.sort((a, b) =>
      (pos.get(a) ?? LAST)
      - (pos.get(b) ?? LAST)
      || compare(a, b)))
    for (const next of outs.get(group) ?? []) {
      depths.set(next, Math.max(
        depths.get(next) ?? 0,
        level + 1 + Math.max(0, groups[next]!.length - 1),
      ))
      const left = (indegree.get(next) ?? 0) - 1
      if (left > 0) indegree.set(next, left)
      else {
        indegree.delete(next)
        ready.push(next)
      }
    }
  }
  return { ids: ids.length === input.length ? ids : [...input], depth }
}

function rootPath(
  c: Corpus, target: string, seedMap: ReadonlyMap<string, Seed>,
  forbidden: ReadonlySet<string>, q: Vocabulary,
): string[] | null {
  const next = new Map<string, string>()
  const depth = new Map([[target, 0]])
  const queue = [target]
  const roots: string[] = []
  for (let cursor = 0; cursor < queue.length && queue.length < 512; cursor += 1) {
    const id = queue[cursor]!
    const n = c.byId.get(id)
    const distance = depth.get(id) ?? 0
    if (!usable(n, q) || distance >= 16) continue
    const parents = n.ins.filter((parent) => usable(c.byId.get(parent), q))
    if (id !== target && parents.length === 0) roots.push(id)
    for (const parent of parents) {
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
      parts: new Set(ids.flatMap((id) =>
        seedMap.get(id)?.parts ?? [])).size,
      terms: new Set(ids.flatMap((id) =>
        seedMap.get(id)?.hits ?? [])).size,
    }]
  })
  return choices.sort((a, b) =>
    a.ids.length - b.ids.length
    || b.parts - a.parts
    || b.terms - a.terms
    || (seedMap.get(b.ids[0]!)?.rank.score ?? 0)
      - (seedMap.get(a.ids[0]!)?.rank.score ?? 0)
    || compare(a.ids[0]!, b.ids[0]!))[0]?.ids ?? null
}

function connect(
  c: Corpus, seeds: readonly Seed[], q: Vocabulary,
): Selection | null {
  const seedMap = new Map(seeds.map((seed) => [seed.n.id, seed]))
  const byId = c.byId
  const hubs = c.nodes.filter((hub) =>
    usable(hub, q) && hub.ins.length > 0 && hub.outs.length > 0)
  const shapes = new Map<string, Array<{
    registryId: string; hooks: string[]; workers: string[]
  }>>()
  for (const file of new Set(hubs.map((hub) => hub.file))) {
    shapes.set(file, (c.files.get(file) ?? []).flatMap((registry) => {
      if (!usable(registry, q) || registry.ins.length < 2) return []
      const pairs = registry.ins.flatMap((hookId) => {
        const registrar = byId.get(hookId)
        if (!usable(registrar, q) || !registrar.owner) return []
        const workers = (c.members.get(registrar.owner) ?? [])
          .filter((id) => id !== hookId && registrar.outs.includes(id)
            && usable(byId.get(id), q))
        return workers.length === 1
          ? [{ hookId, workerId: workers[0]! }] : []
      })
      const hooks = [...new Set(pairs.map((pair) => pair.hookId))]
      const workers = [...new Set(pairs.map((pair) => pair.workerId))]
      const role = (id: string): string => {
        const n = byId.get(id)!
        return `${n.kind}\0${text(n.attributes, 'label').replace(/^\./u, '')}`
      }
      return hooks.length >= 2 && hooks.length === workers.length
        && new Set(hooks.map(role)).size === 1
        && new Set(workers.map(role)).size === 1
        && role(hooks[0]!) !== role(workers[0]!)
        ? [{ registryId: registry.id, hooks, workers }] : []
    }))
  }
  const choices = hubs.flatMap((hub) =>
    (shapes.get(hub.file) ?? [])
      .filter(({ registryId }) => registryId !== hub.id)
      .flatMap(({ hooks, workers }) => {
        const hits = workers.filter((id) => hub.outs.includes(id)).length
        if (hits * 2 >= workers.length) return []
        const entry = rootPath(
          c, hub.id, seedMap, new Set([...hooks, ...workers]),
          q,
        )
        if (!entry) return []
        const relevant = [...entry, ...workers]
        const scopes = q.scopes.filter((s) => !s.hard)
        const matchesQuery = scopes.length > 0
          ? scopes.every((s) => c.nodes.some((n) =>
            usable(n, q) && inScope(n, s)
            && relevant.some((id) => !!path(c, id, n.id, q, false, 3))))
          : relevant.some((id) => seedMap.has(id))
        return matchesQuery ? [{ hub, workers, entry }] : []
      }))
    .sort((a, b) =>
      Number(seedMap.has(b.hub.id)) - Number(seedMap.has(a.hub.id))
      || b.hub.ins.length - a.hub.ins.length
      || b.workers.length - a.workers.length
      || compare(a.hub.id, b.hub.id))
  const pick = choices[0]
  if (!pick) return null
  const branches = pick.workers.map((workerId) => {
    const worker = byId.get(workerId)!
    const services = worker.outs.filter((id) => usable(byId.get(id), q))
    const service = [...services].sort((a, b) =>
      Number(!!path(c, b, pick.hub.id, q))
      - Number(!!path(c, a, pick.hub.id, q))
      || Number(byId.get(b)?.file !== worker.file)
      - Number(byId.get(a)?.file !== worker.file)
      || (seedMap.get(b)?.rank.score ?? 0)
      - (seedMap.get(a)?.rank.score ?? 0)
      || compare(a, b))[0]
    return {
      workerId, service,
      hits: pick.hub.outs.includes(workerId),
      returns: !!service && !!path(c, service, pick.hub.id, q),
    }
  }).sort((a, b) =>
    Number(b.hits) - Number(a.hits)
    || Number(b.returns) - Number(a.returns)
    || (byId.get(a.service ?? '')?.outs.length
      ?? LAST)
      - (byId.get(b.service ?? '')?.outs.length
        ?? LAST)
    || (seedMap.get(b.workerId)?.rank.score ?? 0)
      - (seedMap.get(a.workerId)?.rank.score ?? 0)
    || compare(a.workerId, b.workerId))
  const ids: string[] = []
  const files = new Set<string>()
  const append = (id?: string): boolean => {
    if (!id || ids.includes(id)) return true
    const n = byId.get(id)
    if (!usable(n, q)) return true
    if (ids.length >= SNIPPET_CAP
      || (n.file && !files.has(n.file) && files.size >= FILE_CAP)) return false
    ids.push(id)
    if (n.file) files.add(n.file)
    return true
  }
  let complete = true
  for (const id of pick.entry) if (!append(id)) complete = false
  const terminal = branches.filter((branch) => !branch.returns)
  for (const branch of branches) {
    if (branch.returns
      || (!!branch.service
        && (termsOf(byId.get(branch.service)!, q, true).length > 0
          || (q.parts.length > 1 && terminal.length === 1
            && q.scopes.every((s) => s.hard))))) {
      if (!append(branch.workerId)) complete = false
    }
    if (branch.returns && !append(branch.service)) complete = false
  }
  const sideBranches: string[] = []
  for (const s of q.scopes.filter((s) => !s.hard)) {
    if (ids.some((id) => inScope(byId.get(id)!, s))) continue
    const side = c.nodes.filter((n) =>
      usable(n, q) && !ids.includes(n.id) && inScope(n, s)
      && n.ins.some((id) => ids.includes(id)))
      .sort((a, b) =>
        (seedMap.get(b.id)?.rank.score ?? 0)
        - (seedMap.get(a.id)?.rank.score ?? 0)
        || compare(a.id, b.id))[0]
    if (!side) {
      complete = false
      continue
    }
    const parent = Math.max(...side.ins.map((id) => ids.indexOf(id)))
    const length = ids.length
    if (parent < 0 || !append(side.id) || ids.length === length) {
      complete = false
      continue
    }
    ids.pop()
    ids.splice(parent + 1, 0, side.id)
    sideBranches.push(side.id)
  }
  if (!q.expand && !q.terms.every((t) => t === 'flow'
    || ids.some((id) => termsOf(byId.get(id)!, q, true).includes(t)))) return null
  return {
    ids, flow: true,
    complete: complete && ids.length > 1,
    structuralRequired: true,
    branch: sideBranches,
  }
}

function causal(
  c: Corpus, seeds: readonly Seed[], q: Vocabulary,
): Selection | null {
  if (seeds.length === 0) return null
  const named = q.scopes.filter((s) => !s.hard)
  const scoped = new Set(named.flatMap((s) => s.tokens))
  const picked = (named.length > 0
    ? seeds.filter((seed) =>
      named.some((s) => inScope(seed.n, s))
      || seed.hits.some((t) => !scoped.has(t)))
    : seeds).slice(0, 32)
  const ids = new Set(picked.map((seed) => seed.n.id))
  for (const n of c.nodes) {
    if (!usable(n, q)) continue
    const children = n.outs.filter((id) => ids.has(id)).length
    if (children < 2) continue
    ids.add(n.id)
    if (ids.size >= 256) break
  }
  const ordered = [...new Set(q.scopes.flatMap((s) =>
    picked.filter((seed) => inScope(seed.n, s))))]
  const filtered = [...new Set([
    ...ordered.map(({ n }) => n.id), ...ids,
  ])].filter((id) => usable(c.byId.get(id), q))
  const files = new Set<string>()
  const bounded = toposort(c, filtered).ids.filter((id) => {
    const n = c.byId.get(id)!
    if (files.size >= FILE_CAP && n.file && !files.has(n.file)) return false
    if (files.size < FILE_CAP && n.file) files.add(n.file)
    return true
  }).slice(0, SNIPPET_CAP)
  const retained = new Set(bounded)
  const edges = bounded.reduce((count, id) =>
    count + c.byId.get(id)!.outs.filter((to) => retained.has(to)).length, 0)
  const depth = toposort(c, bounded).depth
  const reachable = ordered.some((from, index) =>
    ordered.slice(index + 1).some((to) =>
      !!path(c, from.n.id, to.n.id, q)))
  if (edges === 0 && (!(q.scopes.length > 1
    || q.terms.filter((t) => /^\d+$/.test(t)).length > 1)
    || (q.limits.length === 0 && !reachable))) return {
    ids: [], flow: false, complete: false,
    structuralRequired: true,
  }
  if (depth < 2 && edges >= 3 && files.size <= 1) return {
    ids: [], flow: false, complete: false,
    structuralRequired: true,
  }
  const conceptCoverage = new Set(picked
    .filter((seed) => retained.has(seed.n.id))
    .flatMap((seed) => seed.parts))
  return {
    ids: bounded,
    flow: bounded.length > 1,
    complete: q.parts.every((concept, index) =>
      concept.size === 0 || conceptCoverage.has(index)),
    structuralRequired: true,
  }
}

function selectStructure(
  c: Corpus, scored: readonly Scored[], q: Vocabulary,
): Selection | null {
  if (!q.structural || q.terms[0] === 'where'
    || (q.scopes.some((s) => !s.hard) && !q.expand)
    || q.limits.some((s) => s.subject.includes('/'))) return null
  if (!q.expand) {
    const matches = scored.map(({ n }) =>
      [n, termsOf(n, q)] as const)
    const coverable = new Set(matches.flatMap(([, terms]) => terms))
    if (matches.some(([n, found]) =>
      found.length * 5 >= coverable.size * 3
        && found.some((t) =>
          matches.filter(([, terms]) => terms.includes(t)).length <= 2)
        && !n.ins.concat(n.outs).some((id) => {
          const adjacent = c.byId.get(id)
          return !!adjacent && termsOf(adjacent, q)
            .some((t) => coverable.has(t) && !found.includes(t))
        }))) return null
  }
  const seeds = scored.flatMap((item): Seed[] => {
    if (!usable(item.n, q)) return []
    const hits = termsOf(item.n, q)
    if (hits.length === 0) return []
    return [{
      ...item, hits,
      parts: q.parts.flatMap((concept, index) =>
        hits.some((t) => concept.has(t)) ? [index] : []),
    }]
  }).sort((a, b) =>
    Number(b.n.ins.length + b.n.outs.length > 0)
    - Number(a.n.ins.length + a.n.outs.length > 0)
    || b.hits.length - a.hits.length
    || byRank(a, b))
  return connect(c, seeds, q)
    ?? causal(c, seeds, q)
}

function fallback(
  index: ReadyQueryIndex, c: Corpus, scored: readonly Scored[],
  q: Vocabulary,
): Selection {
  const ids: string[] = []
  const files = new Set<string>()
  const covered = new Set<string>()
  const add = (item: Scored): void => {
    if (ids.includes(item.n.id)) return
    if (item.n.file && !files.has(item.n.file)
      && files.size >= FILE_CAP) return
    ids.push(item.n.id)
    if (item.n.file) files.add(item.n.file)
    for (const t of item.rank.matchedTerms) covered.add(t)
  }
  if (q.limits.some((s) => s.subject.includes('/'))) {
    for (const s of q.limits.filter((item) =>
      item.subject.includes('/'))) {
      const matching = scored.filter((item) => inScope(item.n, s))
      const file = matching.find((item) => item.n.kind === 'file')
      const symbol = matching.find((item) => item.n.kind !== 'file'
        && (!file || index.graph.edgesBetween(file.n.id, item.n.id)
          .some(({ attributes }) => text(attributes, 'relation') === 'contains')))
      if (file) add(file)
      if (symbol) add(symbol)
    }
  } else if (q.parts.length > 1) {
    for (const concept of q.parts) {
      const next = scored.filter((item) =>
        item.rank.matchedTerms.some((t) => concept.has(t)))
        .sort((a, b) =>
          Number(!files.has(b.n.file)) - Number(!files.has(a.n.file))
          || byRank(a, b))[0]
      if (next) add(next)
    }
  } else {
    const loc = q.terms[0] === 'where'
    const pos = (item: Scored): number[] =>
      termsOf(item.n, q, true).map((t) => q.pos.get(t) ?? LAST)
    const start = loc ? [...scored].sort((a, b) =>
      b.rank.matchedTerms.length - a.rank.matchedTerms.length
      || Math.min(LAST, ...pos(a)) - Math.min(LAST, ...pos(b))
      || pos(b).length - pos(a).length
      || byRank(a, b))[0] : scored[0]
    const exact = start && start.n.kind !== 'class' && start.n.kind !== 'file'
      && exactLabel(start.n, q)
    const first = start && (exact ? start : scored.find((item) =>
      item.n.file === start.n.file
      && start.n.outs.includes(item.n.id)
      && start.rank.matchedTerms.every((t) =>
        item.rank.matchedTerms.includes(t))
      && termsOf(item.n, q, true).length
        >= termsOf(start.n, q, true).length) ?? start)
    if (first) add(first)
    while (ids.length < (exact && loc ? 1 : loc ? 2 : SNIPPET_CAP)) {
      const next = scored.filter((item) => !ids.includes(item.n.id)
        && (files.has(item.n.file) || files.size < FILE_CAP))
        .sort((a, b) => {
          const link = (item: Scored): number => Number(ids.some((id) =>
            index.graph.edgesBetween(id, item.n.id).some(({ attributes }) =>
              CAUSAL.has(text(attributes, 'relation')))))
          const novelty = (item: Scored): number =>
            item.rank.matchedTerms.filter((t) => !covered.has(t)).length
          return (loc
            ? link(b) - link(a)
              || Math.max(-1, ...pos(b)) - Math.max(-1, ...pos(a))
              || pos(b).length - pos(a).length
              || novelty(b) - novelty(a)
            : novelty(b) - novelty(a) || link(b) - link(a))
            || a.rank.firstMatch - b.rank.firstMatch
            || byRank(a, b)
      })[0]
      if (!next) break
      const novel = next.rank.matchedTerms.some((t) => !covered.has(t))
      const connected = termsOf(next.n, q).length > 0 && ids.some((id) =>
        index.graph.edgesBetween(id, next.n.id).some(({ attributes }) =>
          CAUSAL.has(text(attributes, 'relation'))))
      if (loc ? !connected : !novel && !connected) break
      add(next)
    }
  }
  const ordered = toposort(c, ids).ids
  return {
    ids: ordered, flow: false, complete: true, structuralRequired: false,
  }
}

function unsupportedCandidates(
  index: ReadyQueryIndex, q: Vocabulary,
): UnsupportedCandidate[] {
  return index.unsupported_sources.flatMap((source): UnsupportedCandidate[] => {
    const extension = source.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    const domain = classifySourceDomain(source.path, index.root_path)
    if (!UNSUPPORTED.test(extension)
      || isPollutedSourcePath(source.path, index.root_path)
      || (domain !== 'production' && domain !== 'unknown')) return []
    const pathTokens = new Set(words(source.path))
    const basename = new Set(words(source.path.split('/').at(-1) ?? source.path))
    const matched = q.terms.filter((t) =>
      !t.includes('_') && !t.includes('-') && pathTokens.has(t))
    const weights = new Map(matched.map((t) => [t, basename.has(t) ? 4 : 1]))
    const s = q.scopes.some((scope) =>
      scope.tokens.every((t) => pathTokens.has(t))
      && tokens(source.path).join('').includes(scope.compact))
    if (!s && (matched.length === 0
      || matched.every((t) => t.length < 4))) return []
    return [{
      path: source.path, terms: matched, weights,
      first: matched.reduce((first, t) =>
        Math.min(first, q.pos.get(t) ?? LAST),
      LAST),
      score: matched.reduce((total, t) =>
        total + t.length ** 2 * (weights.get(t) ?? 1) * 100,
      s ? 1_000_000 : 0),
    }]
  }).sort((a, b) =>
    b.score - a.score || a.first - b.first
    || compare(a.path, b.path))
}

function unsupportedBoundaries(
  choices: readonly UnsupportedCandidate[],
): EvidenceBoundary[] {
  const picked: UnsupportedCandidate[] = []
  const covered = new Set<string>()
  const rest = [...choices]
  while (rest.length > 0 && picked.length < 4) {
    rest.sort((a, b) => {
      const novelty = (item: UnsupportedCandidate): number =>
        item.terms.filter((t) => !covered.has(t))
          .reduce((total, t) =>
            total + t.length ** 2 * (item.weights.get(t) ?? 1), 0)
      return novelty(b) - novelty(a)
        || b.score - a.score || compare(a.path, b.path)
    })
    const next = rest.shift()!
    if (picked.length > 0
      && next.terms.every((t) => covered.has(t))
      && next.score * 3 < picked[0]!.score) break
    picked.push(next)
    for (const t of next.terms) covered.add(t)
  }
  const boundaries: EvidenceBoundary[] = picked
    .map((item): EvidenceBoundary => ({
      kind: 'unsupported', subject: item.path,
    }))
    .sort((a, b) => compare(a.subject, b.subject))
  return picked.length >= 4 && rest.length > 0
    ? [...boundaries, { kind: 'truncated', subject: 'unsupported sources' }]
    : boundaries
}

export function rankQueryAnchors(
  index: ReadyQueryIndex, request: NormalizedRetrieveRequest,
): RankQueryResult {
  const c = buildCorpus(index)
  const q = vocabulary(request.question)
  const active = (s: Scope): boolean => !s.hard
    || s.subject.includes('/') || c.nodes.some((n) => {
      const prefix = s.tokens.filter((t) => !/^\d+$/.test(t))
      return prefix.every((t) => n.tokens.has(t))
        && [...n.tokens].some((t) => /^\d+$/.test(t))
    })
  for (const s of q.scopes.filter((s) => !active(s))) {
    const outside = new Set(tokens(request.question.replaceAll(s.subject, '')))
    q.terms = q.terms.filter((t) =>
      !/^\d+$/.test(t) || !s.tokens.includes(t) || outside.has(t))
  }
  q.scopes = q.scopes.filter(active)
  q.limits = q.scopes.filter((s) => s.hard)
  const outside = unsupportedCandidates(index, q)
  const unsupportedFacts = unsupportedBoundaries(outside)
  const missing = q.scopes.flatMap((s): EvidenceBoundary[] => {
    const graphMatches = c.nodes.filter((n) => inScope(n, s))
    if (graphMatches.some((n) => n.eligible)
      || outside.some((item) =>
        tokens(item.path).join('').includes(s.compact))) return []
    return [{
      kind: graphMatches.length > 0 ? 'unavailable' : 'missing',
      subject: s.subject,
    }]
  })
  const found = q.scopes.filter((s) =>
    c.nodes.some((n) => n.eligible && inScope(n, s)))
  const limits = q.limits.filter((s) =>
    found.includes(s))
  const scoped = new Set(found.flatMap((s) => s.tokens))
  const allScopedTerms = new Set(q.scopes.flatMap((s) => s.tokens))
  const unscopedTerms = new Set(q.terms.filter((t) => !allScopedTerms.has(t)))
  const outsideTerms = new Set(q.terms.filter((t) => !scoped.has(t)))
  const has = (n: Node, terms: ReadonlySet<string>): boolean =>
    [...terms].some((t) => matches(n.tokens, t)
      || n.ins.concat(n.outs).some((id) => {
        const adjacent = c.byId.get(id)
        return !!adjacent?.eligible && matches(adjacent.tokens, t)
      }))
  const keep = (n: Node): boolean => q.limits.length > 0
    ? limits.some((s) => inScope(n, s))
    : q.scopes.length === 0
      || (found.length === 0
        ? has(n, unscopedTerms)
        : found.some((s) => inScope(n, s))
          || has(n, outsideTerms))
  const pool = scoredNodes(c, q, keep)
  const structural = selectStructure(c, pool, q)
  const choice = structural ?? fallback(
    index, c, pool, q,
  )
  const anchors = choice.ids.flatMap((id, ordinal): RankedQueryNode[] => {
    const existing = pool.find((item) => item.n.id === id)?.rank
    if (existing) return [existing]
    const n = c.byId.get(id)
    if (!n?.eligible) return []
    const matchedTerms = termsOf(n, q)
    return [{
      id, attributes: n.attributes,
      score: Math.max(0, (pool[0]?.rank.score ?? 0) - ordinal),
      matchedTerms,
      firstMatch: matchedTerms.reduce((first, t) =>
        Math.min(first, q.pos.get(t) ?? LAST),
      LAST),
    }]
  })
  const picked = new Set(anchors.map((anchor) => anchor.id))
  const selectedFiles = new Set(anchors.map((anchor) =>
    text(anchor.attributes, 'source_file')))
  const truncated = pool.some(({ n }) => !picked.has(n.id))
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
    queryTerms: q.terms, flow: choice.flow, branch: choice.branch ?? [],
    sequential: q.sequential,
    priorityAnchorIds: choice.ids,
    structuralRequired: choice.structuralRequired,
    structuralCoverageComplete: choice.complete
      && (!choice.structuralRequired || missing.length === 0),
  }
}
