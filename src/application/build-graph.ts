import { createHash } from 'node:crypto'
import { validateExtraction } from '../contracts/extraction.js'
import type { ExtractionData, ExtractionEdge, ExtractionNode, ExtractionSchemaVersion, Hyperedge } from '../contracts/types.js'
import { DEFAULT_EXTRACTION_LAYER, type ExtractionLayer } from '../core/layers/types.js'
import { appendDerivedProvenance, deriveIngestProvenanceFromRecord, normalizeMetadataString } from '../core/provenance/ingest.js'
import { createBaselineProvenance, type ExtractionProvenance } from '../core/provenance/types.js'
import { canonicalJsonString, compareCodeUnits } from '../domain/graph/canonical-json.js'
import { KnowledgeGraph, normalizeGraphPathIdentity } from '../domain/graph/directed-multigraph.js'
import { isRecord } from '../shared/guards.js'
type Normalized<T> = T & { layer: ExtractionLayer; provenance: ExtractionProvenance[] }
export type NormalizedExtractionNode = Normalized<ExtractionNode>
export type NormalizedExtractionEdge = Normalized<ExtractionEdge>
export type NormalizedHyperedge = Normalized<Hyperedge>
export type NormalizedExtractionData = Omit<ExtractionData, 'schema_version' | 'nodes' | 'edges' | 'hyperedges'> & { schema_version: ExtractionSchemaVersion; nodes: NormalizedExtractionNode[]; edges: NormalizedExtractionEdge[]; hyperedges: NormalizedHyperedge[] }
export interface BuildGraphOptions { rootPath?: string; validateExtraction?: boolean }
type BuildableExtraction = Pick<ExtractionData, 'nodes' | 'edges'> & Partial<Pick<ExtractionData, 'schema_version' | 'hyperedges' | 'input_tokens' | 'output_tokens'>>
interface NodeOccurrence { node: NormalizedExtractionNode; originalId: string; sourceIdentity: string; semanticIdentity: string }
interface PreparedNode { id: string; sourceIdentity: string; attributes: Record<string, unknown> }
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : []
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => entry === undefined ? null : sanitize(entry))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, sanitize(entry)]))
}
const normalizeLayer = (value: unknown): ExtractionLayer =>
  value === 'semantic' || value === 'media' || value === 'base' ? value : DEFAULT_EXTRACTION_LAYER
function ingestProvenance(nodes: unknown): Map<string, ExtractionProvenance[]> {
  const byFile = new Map<string, Map<string, ExtractionProvenance>>()
  for (const node of records(nodes)) {
    const sourceFile = normalizeMetadataString(node.source_file)
    if (!sourceFile) continue
    const provenance = deriveIngestProvenanceFromRecord(node)
    if (provenance) {
      const facts = byFile.get(sourceFile) ?? new Map<string, ExtractionProvenance>()
      facts.set(canonicalJsonString(provenance), provenance)
      byFile.set(sourceFile, facts)
    }
  }
  return new Map([...byFile].map(([file, facts]) => [file, [...facts].sort(([left], [right]) => compareCodeUnits(left, right)).map(([, fact]) => fact)]))
}
function provenanceFor(value: unknown, sourceFile: unknown, sourceLocation: unknown, derived: ExtractionProvenance[]): ExtractionProvenance[] {
  const supplied = Array.isArray(value)
    ? value.filter(isRecord).map((entry) => structuredClone(entry as ExtractionProvenance))
    : []
  const baseline = supplied.length > 0 ? supplied : [createBaselineProvenance({
    ...(typeof sourceFile === 'string' ? { sourceFile } : {}), ...(typeof sourceLocation === 'string' ? { sourceLocation } : {}),
  })]
  return derived.reduce((result, fact) => appendDerivedProvenance(result, fact), baseline)
}
function normalizeFact<T extends ExtractionNode | ExtractionEdge>(fact: T, ingestByFile: Map<string, ExtractionProvenance[]>): Normalized<T> {
  const sourceFile = typeof fact.source_file === 'string' ? fact.source_file : ''
  return { ...fact, layer: normalizeLayer(fact.layer),
    provenance: provenanceFor(fact.provenance, sourceFile, fact.source_location, ingestByFile.get(sourceFile) ?? []) }
}
export function normalizeExtractionData(extraction: unknown): NormalizedExtractionData {
  if (!isRecord(extraction)) return { schema_version: 1, nodes: [], edges: [], hyperedges: [] }
  const cloned = sanitize(structuredClone(extraction)) as Record<string, unknown>
  const ingestByFile = ingestProvenance(cloned.nodes)
  const hyperedges = records(cloned.hyperedges).map((value) => {
    const edge = value as Hyperedge
    const sourceFile = typeof edge.source_file === 'string' ? edge.source_file : ''
    return { ...edge,
      nodes: Array.isArray(edge.nodes) ? [...new Set(edge.nodes)].sort(compareCodeUnits) : [], layer: normalizeLayer(edge.layer),
      provenance: provenanceFor(edge.provenance, sourceFile, undefined, ingestByFile.get(sourceFile) ?? []) }
  })
  return {
    ...cloned,
    schema_version: cloned.schema_version === 2 ? 2 : 1,
    nodes: records(cloned.nodes).map((node) => normalizeFact(node as ExtractionNode, ingestByFile)),
    edges: records(cloned.edges).map((edge) => normalizeFact(edge as ExtractionEdge, ingestByFile)),
    hyperedges,
  } as NormalizedExtractionData
}
function confidenceScore(attributes: Record<string, unknown>): number | undefined {
  if (typeof attributes.confidence_score === 'number' && Number.isFinite(attributes.confidence_score)) return attributes.confidence_score
  return attributes.confidence === 'AMBIGUOUS' ? 0.2
    : attributes.confidence === 'INFERRED' ? 0.5
      : attributes.confidence === 'EXTRACTED' ? 1 : undefined
}
const sourceIdentity = (value: unknown, rootPath?: string): string =>
  normalizeGraphPathIdentity(value, rootPath) ?? '<unknown-source>'
function semanticIdentity(node: NormalizedExtractionNode, source: string): string {
  const location = typeof node.source_location === 'string' ? node.source_location.trim() : ''
  const start = /^L?(\d+)(?:(?:C|:)(\d+))?/i.exec(location)
  return canonicalJsonString({
    source_file: source,
    source_location: start
      ? `line:${Number(start[1])}${start[2] ? `:column:${Number(start[2])}` : ''}`
      : location || `id:${node.id}`,
    label: node.label ?? null,
  })
}
function uniqueValues(values: unknown[]): unknown[] {
  const unique = new Map(values.map((value) => [canonicalJsonString(value), structuredClone(value)]))
  return [...unique].sort(([left], [right]) => compareCodeUnits(left, right)).map(([, value]) => value)
}
function mergeNodeFacts(nodes: NormalizedExtractionNode[]): Record<string, unknown> {
  const facts = nodes.map(({ id: _id, ...fact }) => fact).sort((left, right) =>
    Object.keys(right).length - Object.keys(left).length
      || compareCodeUnits(canonicalJsonString(left), canonicalJsonString(right)))
  const merged = structuredClone(facts[0] ?? {}) as Record<string, unknown>
  const variants: Record<string, unknown[]> = {}
  for (const key of [...new Set(facts.flatMap(Object.keys))].sort()) {
    const values = uniqueValues(facts.flatMap((fact) => Object.hasOwn(fact, key) ? [fact[key]] : []))
    if (key === 'provenance') {
      merged[key] = uniqueValues(values.flatMap((value) => Array.isArray(value) ? value : []))
    } else {
      if (!Object.hasOwn(merged, key)) merged[key] = values[0]
      if (values.length > 1) variants[key] = values
    }
  }
  if (Object.keys(variants).length > 0) merged.fact_variants = variants
  return merged
}
function collisionNodeId(originalId: string, identity: string): string {
  const suffix = createHash('sha256').update(canonicalJsonString({ original_id: originalId, source_file: identity })).digest('hex').slice(0, 12)
  return `${originalId}__${suffix}`
}
function prepareNodes(nodes: NormalizedExtractionNode[], rootPath?: string) {
  const occurrences: NodeOccurrence[] = nodes.flatMap((node) => {
    if (typeof node.id !== 'string' || node.id.length === 0) return []
    const source = sourceIdentity(node.source_file, rootPath)
    return [{ node, originalId: node.id, sourceIdentity: source, semanticIdentity: semanticIdentity(node, source) }]
  })
  const semanticsById = new Map<string, Set<string>>()
  const bySemantic = new Map<string, NodeOccurrence[]>()
  for (const occurrence of occurrences) {
    const semantics = semanticsById.get(occurrence.originalId) ?? new Set<string>()
    semantics.add(occurrence.semanticIdentity)
    semanticsById.set(occurrence.originalId, semantics)
    bySemantic.set(occurrence.semanticIdentity, [...(bySemantic.get(occurrence.semanticIdentity) ?? []), occurrence])
  }
  const canonicalId = (group: NodeOccurrence[]): string => [...new Set(group.map(({ originalId }) => originalId))]
    .sort((left, right) =>
      (semanticsById.get(left)?.size ?? 0) - (semanticsById.get(right)?.size ?? 0)
      || right.length - left.length
      || compareCodeUnits(left, right))[0]!
  const groupsById = new Map<string, NodeOccurrence[][]>()
  for (const group of bySemantic.values()) {
    const id = canonicalId(group)
    groupsById.set(id, [...(groupsById.get(id) ?? []), group])
  }
  const prepared: PreparedNode[] = []
  const finalBySemantic = new Map<string, PreparedNode>()
  for (const [id, groups] of [...groupsById].sort(([left], [right]) => compareCodeUnits(left, right))) {
    for (const group of groups.sort((left, right) => compareCodeUnits(left[0]!.semanticIdentity, right[0]!.semanticIdentity))) {
      const identity = group[0]!.semanticIdentity
      const node = {
        id: groups.length > 1 ? collisionNodeId(id, identity) : id,
        sourceIdentity: group[0]!.sourceIdentity,
        attributes: mergeNodeFacts(group.map(({ node: fact }) => fact)),
      }
      prepared.push(node)
      finalBySemantic.set(identity, node)
    }
  }
  const candidatesById = new Map<string, PreparedNode[]>()
  for (const occurrence of occurrences) {
    const node = finalBySemantic.get(occurrence.semanticIdentity)!
    const candidates = candidatesById.get(occurrence.originalId) ?? []
    if (!candidates.some(({ id }) => id === node.id)) candidates.push(node)
    candidatesById.set(occurrence.originalId, candidates)
  }
  for (const candidates of candidatesById.values()) candidates.sort((left, right) => compareCodeUnits(left.id, right.id))
  return {
    nodes: prepared,
    resolveEndpoint(id: string, edgeSourceFile: unknown, sourceEndpoint: boolean): string | undefined {
      const candidates = candidatesById.get(id) ?? []
      if (candidates.length === 1) return candidates[0]!.id
      if (candidates.length === 0) return undefined
      const exact = candidates.filter((candidate) => candidate.id === id)
      if (exact.length === 1) return exact[0]!.id
      if (sourceEndpoint) {
        const source = sourceIdentity(edgeSourceFile, rootPath)
        const local = candidates.filter((candidate) => candidate.sourceIdentity === source)
        if (local.length === 1) return local[0]!.id
      }
      throw new Error(`Graph endpoint ${JSON.stringify(id)} is ambiguous across ${candidates.map(({ id: value }) => value).join(', ')}`)
    },
  }
}
export function buildGraphFromExtraction(extraction: unknown, options: BuildGraphOptions = {}): KnowledgeGraph {
  const rootPath = options.rootPath ?? (isRecord(extraction) && typeof extraction.root_path === 'string' ? extraction.root_path : undefined)
  const graph = new KnowledgeGraph(rootPath ? { root_path: rootPath } : {})
  if (!isRecord(extraction)) return graph
  const normalized = normalizeExtractionData(extraction)
  if (options.validateExtraction !== false) {
    const errors = validateExtraction(extraction)
    if (errors.length > 0) console.warn(`[madar] Extraction warning (${errors.length} issues): ${errors[0]}`)
  }
  const prepared = prepareNodes(normalized.nodes, rootPath)
  const diagnostics: string[] = []
  for (const node of prepared.nodes) graph.addNode(node.id, node.attributes)
  for (const edge of normalized.edges) {
    const { source, target, _src: _obsoleteSource, _tgt: _obsoleteTarget, ...attributes } = edge
    if (typeof source !== 'string' || typeof target !== 'string') throw new Error('Graph edge endpoints must be strings')
    const resolvedSource = prepared.resolveEndpoint(source, edge.source_file, true)
    const resolvedTarget = target === source
      ? resolvedSource
      : prepared.resolveEndpoint(target, edge.source_file, false)
    if (!resolvedSource || !resolvedTarget) {
      diagnostics.push(`Dropped edge ${JSON.stringify(source)} -> ${JSON.stringify(target)}: endpoint missing`)
      continue
    }
    const score = confidenceScore(attributes)
    graph.addEdge(resolvedSource, resolvedTarget, {
      ...attributes,
      ...(score === undefined ? {} : { confidence_score: score }),
    })
  }
  const hyperedges = uniqueValues(normalized.hyperedges.flatMap((edge) => {
    const nodes = edge.nodes.map((id) => prepared.resolveEndpoint(id, edge.source_file, false))
    if (nodes.some((id) => id === undefined)) {
      diagnostics.push(`Dropped hyperedge ${JSON.stringify(edge.id ?? edge.label ?? '<anonymous>')}: endpoint missing`)
      return []
    }
    return [{ ...edge, nodes: [...new Set(nodes as string[])].sort(compareCodeUnits) }]
  })) as NormalizedHyperedge[]
  Object.assign(graph.graph, {
    schema_version: normalized.schema_version,
    ...(hyperedges.length > 0 ? { hyperedges } : {}),
    ...(diagnostics.length > 0 ? { build_diagnostics: [...new Set(diagnostics)].sort() } : {}),
    ...(extraction.spi_mode === true ? { spi_mode: true } : {}),
    ...(isRecord(extraction.graph_build_freshness)
      ? { graph_build_freshness: structuredClone(extraction.graph_build_freshness) } : {}),
  })
  return graph
}
export function buildGraph(extractions: BuildableExtraction[], options: BuildGraphOptions = {}): KnowledgeGraph {
  const combined = extractions.reduce<ExtractionData>((result, extraction) => ({
    schema_version: result.schema_version === 2 || extraction.schema_version === 2 ? 2 : 1,
    nodes: [...result.nodes, ...extraction.nodes],
    edges: [...result.edges, ...extraction.edges],
    hyperedges: [...(result.hyperedges ?? []), ...(extraction.hyperedges ?? [])],
    input_tokens: (result.input_tokens ?? 0) + (extraction.input_tokens ?? 0),
    output_tokens: (result.output_tokens ?? 0) + (extraction.output_tokens ?? 0),
  }), { schema_version: 1, nodes: [], edges: [], hyperedges: [], input_tokens: 0, output_tokens: 0 })
  return buildGraphFromExtraction(combined, options)
}
