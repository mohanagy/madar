// Multi-resolution context representations (#76 — v0.16).
//
// Adapts a CompiledContextPack (or any pack-shaped node list) to three
// resolutions:
//
//   * 'detail'   — full snippet + all node metadata (current default)
//   * 'summary'  — label + source_file + line_number + match_score only
//                  (snippet bodies dropped to save tokens)
//   * 'mixed'   — top-N most relevant nodes get 'detail', rest get
//                 'summary'. N is configurable (default: ceil(nodes/3))
//
// The transform is non-destructive: pass any node list and get a new
// list back with the requested resolution applied. Consumers that need
// the full pack metadata (coverage, claims, etc.) keep the original
// upstream pack; this helper only reshapes the per-node payload.
//
// Why it lives here and not in compact-context-pack: this is a UX/
// budget-shaping decision that's downstream of compaction. Compaction
// is about taking the OUTER LIMIT (max_nodes); resolution is about
// shaping each node's payload so the agent can decide whether to expand.

import type {
  ContextPackNode,
  ContextPackRelationship,
  ContextPackTaskKind,
  ContextRepresentationType,
} from '../contracts/context-pack.js'

export type ContextPackResolution = 'detail' | 'summary' | 'mixed' | 'signature' | 'sketch'

export interface ApplyResolutionOptions {
  resolution: ContextPackResolution
  /** For 'mixed': number of top nodes that retain full detail. Defaults
   *  to ceil(nodes.length / 3) so a 12-node pack keeps 4 detail nodes. */
  detail_top_n?: number
  relationships?: readonly ContextPackRelationship[]
  task_kind?: ContextPackTaskKind
}

export interface ApplyResolutionResult<T extends ContextPackNode> {
  nodes: T[]
  /** Per-node resolution after applying. Useful for diagnostics.
   *  v0.20 #132: includes 'signature' for nodes where the body was
   *  dropped but the function signature retained. */
  resolution_map: Array<{ node_id: string | undefined; resolution: ContextRepresentationType }>
  /** Estimated bytes saved (rough — based on dropped snippet length). */
  bytes_saved: number
}

/** Apply a resolution to a list of context-pack nodes. Pure and
 *  deterministic — same input always produces the same output. */
export function applyContextPackResolution<T extends ContextPackNode>(
  nodes: ReadonlyArray<T>,
  options: ApplyResolutionOptions,
): ApplyResolutionResult<T> {
  if (options.resolution === 'detail') {
    return {
      nodes: [...nodes],
      resolution_map: nodes.map((n) => ({ node_id: n.node_id, resolution: 'detail' })),
      bytes_saved: 0,
    }
  }

  if (options.resolution === 'summary') {
    return summarizeAll(nodes)
  }

  if (options.resolution === 'signature') {
    return signatureResolution(nodes)
  }

  if (options.resolution === 'sketch') {
    return sketchResolution(nodes, options.relationships ?? [], options.task_kind)
  }

  // mixed: top-N detail by match_score desc, rest summary.
  const n = options.detail_top_n ?? Math.ceil(nodes.length / 3)
  return mixedResolution(nodes, Math.max(0, n))
}

/** Signature resolution: keep the first 1-2 lines of the snippet (the
 *  function/class signature) and drop the body. Middle ground between
 *  full `detail` and bare `summary`. Useful when the agent needs to see
 *  parameter types and return shape but doesn't need the body.
 *
 *  Heuristic: keep lines up to and including the line that ends with `{`
 *  (the opening brace), then drop the rest. If no `{` is found in the
 *  first 3 lines, keep the first 2 lines as a best-effort signature. */
function signatureResolution<T extends ContextPackNode>(
  nodes: ReadonlyArray<T>,
): ApplyResolutionResult<T> {
  let bytesSaved = 0
  const transformed = nodes.map((node) => {
    if (typeof node.snippet !== 'string' || node.snippet.length === 0) return node
    const sig = extractSignature(node.snippet)
    bytesSaved += Math.max(0, node.snippet.length - sig.length)
    return {
      ...node,
      snippet: sig,
      representation_type: 'signature',
      representation_reason: 'signature compression',
    } as T
  })
  return {
    nodes: transformed,
    // CodeRabbit fix: signature mode is its own resolution, NOT 'summary'.
    // Downstream diagnostics differentiate 'has signature info' from
    // 'has no body at all'.
    resolution_map: nodes.map((n) => ({ node_id: n.node_id, resolution: 'signature' as const })),
    bytes_saved: bytesSaved,
  }
}

function extractSignature(snippet: string): string {
  const lines = snippet.split('\n')
  for (let i = 0; i < Math.min(3, lines.length); i += 1) {
    const line = lines[i]
    if (line === undefined) continue
    if (line.trimEnd().endsWith('{') || line.trimEnd().endsWith('=>')) {
      return lines.slice(0, i + 1).join('\n')
    }
  }
  // No brace found in the first 3 lines — take the first 2 as the
  // best-effort signature, or the whole snippet if it's shorter.
  return lines.slice(0, Math.min(2, lines.length)).join('\n')
}

function summarizeAll<T extends ContextPackNode>(
  nodes: ReadonlyArray<T>,
): ApplyResolutionResult<T> {
  let bytesSaved = 0
  const transformed = nodes.map((node) => {
    bytesSaved += dropSnippetBytes(node)
    return summarizeNode(node)
  })
  return {
    nodes: transformed,
    resolution_map: nodes.map((n) => ({ node_id: n.node_id, resolution: 'summary' })),
    bytes_saved: bytesSaved,
  }
}

function mixedResolution<T extends ContextPackNode>(
  nodes: ReadonlyArray<T>,
  detailCount: number,
): ApplyResolutionResult<T> {
  // Rank by match_score desc; stable for ties using original index.
  const indexed = nodes.map((node, idx) => ({ node, idx, score: node.match_score ?? 0 }))
  indexed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.idx - b.idx
  })
  const detailIndices = new Set<number>()
  for (let i = 0; i < Math.min(detailCount, indexed.length); i += 1) {
    detailIndices.add(indexed[i]!.idx)
  }

  let bytesSaved = 0
  const out: T[] = []
  const resolutionMap: Array<{ node_id: string | undefined; resolution: 'detail' | 'summary' | 'signature' }> = []
  nodes.forEach((node, idx) => {
    if (detailIndices.has(idx)) {
      out.push(node)
      resolutionMap.push({ node_id: node.node_id, resolution: 'detail' })
    } else {
      bytesSaved += dropSnippetBytes(node)
      out.push(summarizeNode(node))
      resolutionMap.push({ node_id: node.node_id, resolution: 'summary' })
    }
  })
  return { nodes: out, resolution_map: resolutionMap, bytes_saved: bytesSaved }
}

function summarizeNode<T extends ContextPackNode>(node: T): T {
  // Drop the snippet body. Preserve all other metadata so the agent can
  // still rank/filter/expand. Casts back to T because the shape is the
  // same — only the snippet content changed.
  return {
    ...node,
    snippet: null,
    representation_type: 'summary',
    representation_reason: 'summary compression',
  } as T
}

function dropSnippetBytes(node: ContextPackNode): number {
  return typeof node.snippet === 'string' ? node.snippet.length : 0
}

function sketchResolution<T extends ContextPackNode>(
  nodes: ReadonlyArray<T>,
  relationships: readonly ContextPackRelationship[],
  taskKind?: ContextPackTaskKind,
): ApplyResolutionResult<T> {
  const relationIndex = buildRelationshipIndex(relationships, nodes)
  let bytesSaved = 0
  const resolutionMap: Array<{ node_id: string | undefined; resolution: ContextRepresentationType }> = []
  const transformed = nodes.map((node) => {
    const rendered = renderSketchRepresentation(node, relationIndex, taskKind)
    if (!rendered) {
      const signature = signatureNode(node)
      bytesSaved += Math.max(0, dropSnippetBytes(node) - (signature.snippet?.length ?? 0))
      resolutionMap.push({ node_id: node.node_id, resolution: 'signature' })
      return signature as T
    }

    bytesSaved += Math.max(0, dropSnippetBytes(node) - rendered.snippet.length)
    resolutionMap.push({ node_id: node.node_id, resolution: rendered.type })
    return {
      ...node,
      snippet: rendered.snippet,
      representation_type: rendered.type,
      representation_reason: rendered.reason,
    } as T
  })

  return {
    nodes: transformed,
    resolution_map: resolutionMap,
    bytes_saved: bytesSaved,
  }
}

function signatureNode<T extends ContextPackNode>(node: T): T {
  if (typeof node.snippet !== 'string' || node.snippet.length === 0) {
    return {
      ...node,
      representation_type: 'signature',
      representation_reason: 'fallback signature',
    } as T
  }

  return {
    ...node,
    snippet: extractSignature(node.snippet),
    representation_type: 'signature',
    representation_reason: 'fallback signature',
  } as T
}

type RelationIndex = {
  outgoing: Map<string, ContextPackRelationship[]>
  incoming: Map<string, ContextPackRelationship[]>
  labelsById: Map<string, string>
}

type SketchRepresentationType =
  | 'behavior_sketch'
  | 'dependency_record'
  | 'call_chain'
  | 'contract_view'
  | 'implementation_excerpt'

type RenderedRepresentation = {
  type: SketchRepresentationType
  reason: string
  snippet: string
}

type RepresentationSignals = {
  behaviorEdges: string[]
  executionEdges: string[]
  tests: string[]
  config: string[]
  readsEnv: string[]
  outgoingDeps: string[]
  incomingDeps: string[]
  callTraces: string[]
  sideEffects: string[]
  latencySensitive: string[]
}

function preferredRelationKeys(id: string | undefined, label: string): string[] {
  return typeof id === 'string' && id.length > 0 ? [id] : [label]
}

function buildRelationshipIndex(
  relationships: readonly ContextPackRelationship[],
  nodes: readonly ContextPackNode[],
): RelationIndex {
  const outgoing = new Map<string, ContextPackRelationship[]>()
  const incoming = new Map<string, ContextPackRelationship[]>()
  const labelsById = new Map<string, string>()
  const labelIds = new Map<string, Set<string>>()

  for (const node of nodes) {
    if (typeof node.node_id === 'string' && node.node_id.length > 0) {
      labelsById.set(node.node_id, node.label)
      const ids = labelIds.get(node.label) ?? new Set<string>()
      ids.add(node.node_id)
      labelIds.set(node.label, ids)
    }
  }

  const uniqueIdsByLabel = new Map<string, string>()
  for (const [label, ids] of labelIds) {
    if (ids.size === 1) {
      uniqueIdsByLabel.set(label, [...ids][0]!)
    }
  }

  const canonicalizeRelationKeys = (id: string | undefined, label: string): string[] => {
    if (typeof id === 'string' && id.length > 0) {
      return [id]
    }
    const uniqueId = uniqueIdsByLabel.get(label)
    return uniqueId ? [uniqueId] : [label]
  }

  for (const relationship of relationships) {
    const fromKeys = canonicalizeRelationKeys(relationship.from_id, relationship.from)
    const toKeys = canonicalizeRelationKeys(relationship.to_id, relationship.to)

    for (const key of fromKeys) {
      outgoing.set(key, [...(outgoing.get(key) ?? []), relationship])
    }
    for (const key of toKeys) {
      incoming.set(key, [...(incoming.get(key) ?? []), relationship])
    }
  }

  return { outgoing, incoming, labelsById }
}

function relationKey(node: ContextPackNode): string[] {
  return preferredRelationKeys(node.node_id, node.label)
}

function relationLabels(
  node: ContextPackNode,
  relationIndex: RelationIndex,
  direction: 'outgoing' | 'incoming',
  relationTypes: readonly string[],
): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  const index = direction === 'outgoing' ? relationIndex.outgoing : relationIndex.incoming

  for (const key of relationKey(node)) {
    for (const relationship of index.get(key) ?? []) {
      if (!relationTypes.includes(relationship.relation)) {
        continue
      }
      const label = direction === 'outgoing'
        ? relationIndex.labelsById.get(relationship.to_id ?? '') ?? relationship.to
        : relationIndex.labelsById.get(relationship.from_id ?? '') ?? relationship.from
      if (!seen.has(label)) {
        seen.add(label)
        labels.push(label)
      }
    }
  }

  return labels
}

function relationEntriesForRef(
  ref: Pick<ContextPackNode, 'node_id' | 'label'>,
  relationIndex: RelationIndex,
  direction: 'outgoing' | 'incoming',
  relationTypes: readonly string[],
): ContextPackRelationship[] {
  const seen = new Set<string>()
  const entries: ContextPackRelationship[] = []
  const index = direction === 'outgoing' ? relationIndex.outgoing : relationIndex.incoming

  for (const key of preferredRelationKeys(ref.node_id, ref.label)) {
    for (const relationship of index.get(key) ?? []) {
      if (!relationTypes.includes(relationship.relation)) {
        continue
      }
      const signature = `${relationship.from_id ?? relationship.from}:${relationship.relation}:${relationship.to_id ?? relationship.to}`
      if (!seen.has(signature)) {
        seen.add(signature)
        entries.push(relationship)
      }
    }
  }

  return entries
}

function buildCallTraces(
  node: ContextPackNode,
  relationIndex: RelationIndex,
  maxHops = 2,
  maxTraces = 3,
): string[] {
  const traces: string[] = []

  const visit = (
    ref: Pick<ContextPackNode, 'node_id' | 'label'>,
    path: string[],
    hops: number,
    seen: Set<string>,
  ): void => {
    const edges = relationEntriesForRef(ref, relationIndex, 'outgoing', ['calls'])

    if (edges.length === 0 || hops >= maxHops) {
      if (path.length > 1) {
        traces.push(path.join(' -> '))
      }
      return
    }

    for (const edge of edges) {
      const nextLabel = relationIndex.labelsById.get(edge.to_id ?? '') ?? edge.to
      const nextKey = edge.to_id ?? nextLabel
      if (seen.has(nextKey)) {
        continue
      }
      const nextSeen = new Set(seen)
      nextSeen.add(nextKey)
      visit(
        { node_id: edge.to_id, label: nextLabel },
        [...path, nextLabel],
        hops + 1,
        nextSeen,
      )
      if (traces.length >= maxTraces) {
        return
      }
    }

    if (traces.length === 0 && path.length > 1) {
      traces.push(path.join(' -> '))
    }
  }

  visit(
    { node_id: node.node_id, label: node.label },
    [node.label],
    0,
    new Set([node.node_id ?? node.label]),
  )

  return traces.slice(0, maxTraces)
}

function collectRepresentationSignals(
  node: ContextPackNode,
  relationIndex: RelationIndex,
): RepresentationSignals {
  const behaviorEdges = relationLabels(node, relationIndex, 'outgoing', ['calls', 'route_handler', 'controller_route', 'method', 'contains'])
  const executionEdges = relationLabels(node, relationIndex, 'outgoing', ['calls'])
  const tests = relationLabels(node, relationIndex, 'outgoing', ['covered_by'])
  const config = relationLabels(node, relationIndex, 'outgoing', ['uses_config'])
  const readsEnv = relationLabels(node, relationIndex, 'outgoing', ['reads_env'])
  const outgoingDeps = relationLabels(node, relationIndex, 'outgoing', ['calls', 'injects', 'depends_on'])
  const incomingDeps = relationLabels(node, relationIndex, 'incoming', ['calls', 'injects', 'depends_on'])
  const { sideEffects, latencySensitive } = sideEffectHints(executionEdges)
  const callTraces = buildCallTraces(node, relationIndex)

  return {
    behaviorEdges,
    executionEdges,
    tests,
    config,
    readsEnv,
    outgoingDeps,
    incomingDeps,
    callTraces,
    sideEffects,
    latencySensitive,
  }
}

function hasBehaviorSignals(node: ContextPackNode, signals: RepresentationSignals): boolean {
  return (
    signals.tests.length > 0
    || signals.config.length > 0
    || signals.readsEnv.length > 0
    || signals.behaviorEdges.length > 1
    || !!node.framework_role
  )
}

function hasDependencySignals(node: ContextPackNode, signals: RepresentationSignals): boolean {
  return (
    signals.outgoingDeps.length > 0
    || signals.incomingDeps.length > 0
    || !!node.framework_role
  )
}

function isContractLikeNode(node: ContextPackNode): boolean {
  const normalizedKind = node.node_kind?.toLowerCase()
  if (
    normalizedKind === 'interface'
    || normalizedKind === 'type'
    || normalizedKind === 'type_alias'
    || normalizedKind === 'enum'
    || normalizedKind === 'property'
    || normalizedKind === 'field'
  ) {
    return true
  }

  const normalizedPath = node.source_file.toLowerCase()
  if (/(?:contract|contracts|schema|schemas|types?|dto|interface)/.test(normalizedPath)) {
    return true
  }

  const normalizedSnippet = node.snippet?.trimStart().toLowerCase()
  return normalizedSnippet !== undefined
    && (
      normalizedSnippet.startsWith('export interface ')
      || normalizedSnippet.startsWith('interface ')
      || normalizedSnippet.startsWith('export type ')
      || normalizedSnippet.startsWith('type ')
      || normalizedSnippet.startsWith('export enum ')
      || normalizedSnippet.startsWith('enum ')
    )
}

function selectRepresentationType(
  node: ContextPackNode,
  signals: RepresentationSignals,
  taskKind?: ContextPackTaskKind,
): SketchRepresentationType | null {
  if (taskKind === 'review') {
    if (isContractLikeNode(node)) {
      return 'contract_view'
    }
    if (node.evidence_class === 'change' && typeof node.snippet === 'string' && node.snippet.length > 0) {
      return 'implementation_excerpt'
    }
    return null
  }

  if (taskKind === 'explain' && node.evidence_class === 'structural' && signals.callTraces.length > 0) {
    return 'call_chain'
  }

  if (taskKind === 'impact' && hasDependencySignals(node, signals)) {
    return 'dependency_record'
  }

  if (hasBehaviorSignals(node, signals)) {
    return 'behavior_sketch'
  }

  if (hasDependencySignals(node, signals)) {
    return 'dependency_record'
  }

  return null
}

function sideEffectHints(labels: readonly string[]): {
  sideEffects: string[]
  latencySensitive: string[]
} {
  const sideEffects = new Set<string>()
  for (const label of labels) {
    const normalized = label.toLowerCase()
    if (
      normalized === 'fetch'
      || normalized.startsWith('axios')
      || normalized.startsWith('got')
      || normalized.startsWith('request')
      || normalized.startsWith('http.')
      || normalized.startsWith('https.')
    ) {
      sideEffects.add('external_http')
    }
    if (
      normalized.includes('anthropic')
      || normalized.includes('openai')
      || normalized.includes('chatcompletion')
      || normalized.includes('messages.create')
      || normalized.includes('responses.create')
    ) {
      sideEffects.add('llm_call')
    }
    if (
      normalized.includes('prisma.')
      && (normalized.endsWith('.create') || normalized.endsWith('.update') || normalized.endsWith('.delete') || normalized.endsWith('.upsert'))
    ) {
      sideEffects.add('db_write')
    }
    if (normalized.includes('redis') || normalized.includes('cache.')) {
      sideEffects.add('cache_io')
    }
    if (normalized.includes('queue') || normalized.includes('publish') || normalized.includes('emit')) {
      sideEffects.add('queue_event')
    }
  }

  const orderedEffects = ['external_http', 'llm_call', 'db_write', 'cache_io', 'queue_event']
  return {
    sideEffects: orderedEffects.filter((effect) => sideEffects.has(effect)),
    latencySensitive: ['external_http', 'llm_call'].filter((effect) => sideEffects.has(effect)),
  }
}

function renderSketchRepresentation(
  node: ContextPackNode,
  relationIndex: RelationIndex,
  taskKind?: ContextPackTaskKind,
): RenderedRepresentation | null {
  const signals = collectRepresentationSignals(node, relationIndex)
  const selectedRepresentation = selectRepresentationType(node, signals, taskKind)

  switch (selectedRepresentation) {
    case 'behavior_sketch':
      return renderBehaviorSketch(node, signals)
    case 'dependency_record':
      return renderDependencyRecord(node, signals)
    case 'call_chain':
      return renderCallChain(node, signals)
    case 'contract_view':
      return renderContractView(node)
    case 'implementation_excerpt':
      return renderImplementationExcerpt(node)
    default:
      return null
  }
}

function renderBehaviorSketch(
  node: ContextPackNode,
  signals: RepresentationSignals,
): RenderedRepresentation {
  const lines = [node.label]
  for (const label of signals.behaviorEdges.slice(0, 5)) {
    lines.push(`-> ${label}`)
  }
  if (signals.tests.length > 0) {
    lines.push(`tests: ${signals.tests.slice(0, 3).join(', ')}`)
  }
  if (signals.readsEnv.length > 0) {
    lines.push(`reads env: ${signals.readsEnv.slice(0, 3).join(', ')}`)
  }
  if (signals.config.length > 0) {
    lines.push(`config: ${signals.config.slice(0, 3).join(', ')}`)
  }
  if (signals.sideEffects.length > 0) {
    lines.push(`side effects: ${signals.sideEffects.join(', ')}`)
  }
  if (signals.latencySensitive.length > 0) {
    lines.push(`latency-sensitive: ${signals.latencySensitive.join(', ')}`)
  }
  if (node.framework_role) {
    lines.push(`framework: ${node.framework_role}`)
  }
  return {
    type: 'behavior_sketch',
    reason: 'graph-derived behavior sketch',
    snippet: lines.join('\n'),
  }
}

function renderDependencyRecord(
  node: ContextPackNode,
  signals: RepresentationSignals,
): RenderedRepresentation {
  const lines = [node.label]
  if (signals.outgoingDeps.length > 0) {
    lines.push(`calls: ${signals.outgoingDeps.slice(0, 3).join(', ')}`)
  }
  if (signals.incomingDeps.length > 0) {
    lines.push(`called by: ${signals.incomingDeps.slice(0, 3).join(', ')}`)
  }
  if (node.framework_role) {
    lines.push(`framework: ${node.framework_role}`)
  }
  if (signals.sideEffects.length > 0) {
    lines.push(`side effects: ${signals.sideEffects.join(', ')}`)
  }
  return {
    type: 'dependency_record',
    reason: 'graph-derived dependency record',
    snippet: lines.join('\n'),
  }
}

function renderCallChain(
  node: ContextPackNode,
  signals: RepresentationSignals,
): RenderedRepresentation | null {
  if (signals.callTraces.length === 0) {
    return null
  }

  return {
    type: 'call_chain',
    reason: 'selected call chain',
    snippet: signals.callTraces.join('\n'),
  }
}

function renderContractView(node: ContextPackNode): RenderedRepresentation | null {
  if (typeof node.snippet !== 'string' || node.snippet.length === 0) {
    return null
  }

  const lines = node.snippet
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) {
    return null
  }

  const header = lines[0] ?? extractSignature(node.snippet)
  const members = lines
    .slice(1)
    .filter((line) => line.trim() !== '}')
    .slice(0, 4)

  return {
    type: 'contract_view',
    reason: 'contract-focused view',
    snippet: [header, ...members].join('\n'),
  }
}

function renderImplementationExcerpt(node: ContextPackNode): RenderedRepresentation | null {
  if (typeof node.snippet !== 'string' || node.snippet.length === 0) {
    return null
  }

  return {
    type: 'implementation_excerpt',
    reason: 'review-focused implementation excerpt',
    snippet: node.snippet,
  }
}
