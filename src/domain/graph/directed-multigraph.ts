import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { canonicalJsonString, canonicalJsonValue, compareCodeUnits } from './canonical-json.js'
export type GraphAttributes = Record<string, unknown>
export interface GraphEdge { id: string; source: string; target: string; attributes: GraphAttributes }
const VOLATILE_IDENTITY_KEYS = new Set(['captured_at', 'created_at', 'generated_at', 'timestamp', 'updated_at'])
function requireNodeId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Graph node ID must be a non-empty string without NUL characters')
  return value
}
function cloneAttributes(attributes: GraphAttributes, path: string): GraphAttributes {
  const value = canonicalJsonValue(attributes, path)
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new TypeError(`${path} must be an object`)
  return value
}
function lexicalPath(value: string): string {
  const slashed = value.trim().replaceAll('\\', '/')
  const collapsed = posix.normalize(slashed)
  const normalized = slashed.startsWith('//') && !collapsed.startsWith('//') ? `/${collapsed}` : collapsed
  return normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized) ? normalized.slice(0, -1) : normalized
}
export function normalizeGraphPathIdentity(value: unknown, rootPath: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const input = lexicalPath(value)
  const absolute = input.startsWith('/') || /^[A-Za-z]:\//.test(input)
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    if (absolute) throw new Error('Graph root_path is required for absolute source paths')
    return input.replace(/^\.\//, '')
  }
  const root = lexicalPath(rootPath)
  const normalized = absolute ? input : lexicalPath(`${root}/${input}`)
  const caseInsensitive = /^[A-Za-z]:\//.test(root) || root.startsWith('//')
  const comparablePath = caseInsensitive ? normalized.toLowerCase() : normalized
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root
  if (comparablePath === comparableRoot) return '.'
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (comparablePath.startsWith(caseInsensitive ? prefix.toLowerCase() : prefix)) return normalized.slice(prefix.length)
  throw new Error(`Graph source path ${JSON.stringify(value)} is outside root_path ${JSON.stringify(rootPath)}`)
}
function normalizeIdentityValue(value: unknown, rootPath: unknown): unknown {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => normalizeIdentityValue(entry, rootPath))
    return [...new Map(entries.map((entry) => [canonicalJsonString(entry), entry]))].sort(([left], [right]) => compareCodeUnits(left, right)).map(([, entry]) => entry)
  }
  if (value === null || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (VOLATILE_IDENTITY_KEYS.has(key)) continue
    result[key] = key === 'source_file' ? normalizeGraphPathIdentity(entry, rootPath)
      : key === 'source_location' && typeof entry === 'string' ? entry.trim()
        : normalizeIdentityValue(entry, rootPath)
  }
  return result
}
function edgeIdentity(source: string, target: string, attributes: GraphAttributes, rootPath: unknown): string {
  const relation = typeof attributes.relation === 'string' ? attributes.relation : ''
  if (!relation || relation !== relation.trim()) throw new Error('Graph edge relation must be a trimmed non-empty string')
  const sourceFile = normalizeGraphPathIdentity(attributes.source_file, rootPath)
  const sourceLocation = typeof attributes.source_location === 'string' ? attributes.source_location.trim() : undefined
  const explicitEvidence = attributes.evidence === undefined ? undefined : normalizeIdentityValue(attributes.evidence, rootPath)
  return canonicalJsonString({ source, target, relation,
    evidence: {
      ...(sourceFile === undefined ? {} : { source_file: sourceFile }),
      ...(sourceLocation === undefined ? {} : { source_location: sourceLocation }),
      ...(explicitEvidence === undefined ? {} : { explicit: explicitEvidence }),
      provenance: normalizeIdentityValue(attributes.provenance ?? [], rootPath),
    } })
}
const sorted = (values: Iterable<string>): string[] => [...values].sort()
function addToIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>()
  values.add(value)
  index.set(key, values)
}
const endpointKey = (source: string, target: string): string => `${source}\u0000${target}`
const edgeId = (identity: string): string => `edge_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
function freezeValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeValue(entry)
    Object.freeze(value)
  }
  return value
}
export class KnowledgeGraph {
  public readonly graph: GraphAttributes
  private readonly nodeMap = new Map<string, GraphAttributes>()
  private readonly edgeMap = new Map<string, GraphEdge>()
  private readonly successorMap = new Map<string, Set<string>>()
  private readonly predecessorMap = new Map<string, Set<string>>()
  private readonly endpointMap = new Map<string, Set<string>>()
  constructor(metadata: GraphAttributes = {}) {
    if (Object.hasOwn(metadata, 'directed') && metadata.directed !== true) throw new Error('Madar graphs are always directed; regenerate the graph without an undirected option')
    const stored = cloneAttributes(metadata, 'graph.metadata')
    for (const key of Object.keys(stored)) stored[key] = freezeValue(stored[key])
    const protectIdentity = (key: string | symbol, value: unknown): void => {
      if (key === 'directed' && value !== true) throw new Error('Madar graphs are always directed')
      if (key === 'root_path' && value !== stored.root_path && this.rootChangesEdgeIds(value)) {
        throw new Error('Graph root_path cannot change after path-bearing edges are inserted')
      }
    }
    this.graph = new Proxy(stored, {
      set: (target, key, value) => {
        if (typeof key !== 'string') throw new TypeError('Graph metadata keys must be strings')
        const next = freezeValue(canonicalJsonValue(value, `graph.metadata.${key}`))
        protectIdentity(key, next)
        return Reflect.defineProperty(target, key, { value: next, enumerable: true, writable: true, configurable: true })
      },
      deleteProperty: (target, key) => {
        protectIdentity(key, undefined)
        return Reflect.deleteProperty(target, key)
      },
      defineProperty: (target, key, descriptor) => {
        if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Graph metadata must use string data properties')
        const value = freezeValue(canonicalJsonValue(descriptor.value, `graph.metadata.${key}`))
        protectIdentity(key, value)
        return Reflect.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
      },
      setPrototypeOf: () => false,
    })
  }
  private rootChangesEdgeIds(rootPath: unknown): boolean {
    try {
      return [...this.edgeMap.values()].some((edge) => edgeId(edgeIdentity(edge.source, edge.target, edge.attributes, rootPath)) !== edge.id)
    } catch { return true }
  }
  addNode(id: string, attributes: GraphAttributes): string {
    const nodeId = requireNodeId(id)
    const nextAttributes = cloneAttributes(attributes, `node[${JSON.stringify(nodeId)}].attributes`)
    const existing = this.nodeMap.get(nodeId)
    if (existing && canonicalJsonString(existing) !== canonicalJsonString(nextAttributes)) throw new Error(`Conflicting graph node facts share ID ${JSON.stringify(nodeId)}`)
    if (existing) return nodeId
    this.nodeMap.set(nodeId, nextAttributes)
    return nodeId
  }
  replaceNodeAttributes(id: string, attributes: GraphAttributes): void {
    const nodeId = requireNodeId(id)
    if (!this.nodeMap.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`)
    this.nodeMap.set(nodeId, cloneAttributes(attributes, `node[${JSON.stringify(nodeId)}].attributes`))
  }
  addEdge(source: string, target: string, attributes: GraphAttributes): string {
    const sourceId = requireNodeId(source)
    const targetId = requireNodeId(target)
    if (!this.nodeMap.has(sourceId) || !this.nodeMap.has(targetId)) throw new Error(`Graph edge endpoints must exist before insertion: ${sourceId} -> ${targetId}`)
    const nextAttributes = cloneAttributes(attributes, `edge[${JSON.stringify(sourceId)},${JSON.stringify(targetId)}].attributes`)
    const identity = edgeIdentity(sourceId, targetId, nextAttributes, this.graph.root_path)
    const id = edgeId(identity)
    const existing = this.edgeMap.get(id)
    if (existing) {
      if (edgeIdentity(existing.source, existing.target, existing.attributes, this.graph.root_path) !== identity) throw new Error(`Graph edge identity hash collision for ${JSON.stringify(id)}`)
      if (compareCodeUnits(canonicalJsonString(nextAttributes), canonicalJsonString(existing.attributes)) < 0) existing.attributes = nextAttributes
      return id
    }
    this.edgeMap.set(id, { id, source: sourceId, target: targetId, attributes: nextAttributes })
    addToIndex(this.successorMap, sourceId, targetId)
    addToIndex(this.predecessorMap, targetId, sourceId)
    addToIndex(this.endpointMap, endpointKey(sourceId, targetId), id)
    return id
  }
  isDirected(): true { return true }
  hasNode(id: string): boolean { return this.nodeMap.has(id) }
  hasEdge(source: string, target: string): boolean { return (this.endpointMap.get(endpointKey(source, target))?.size ?? 0) > 0 }
  numberOfNodes(): number { return this.nodeMap.size }
  numberOfEdges(): number { return this.edgeMap.size }
  nodeIds(): string[] { return sorted(this.nodeMap.keys()) }
  nodeEntries(): Array<[string, GraphAttributes]> { return this.nodeIds().map((id) => [id, this.nodeAttributes(id)]) }
  edgeEntries(): Array<[string, string, GraphAttributes, string]> {
    return sorted(this.edgeMap.keys()).map((id) => {
      const edge = this.edgeMap.get(id)!
      return [edge.source, edge.target, cloneAttributes(edge.attributes, `edge[${id}].attributes`), id]
    })
  }
  edgesBetween(source: string, target: string): GraphEdge[] {
    return sorted(this.endpointMap.get(endpointKey(source, target)) ?? []).map((id) => {
      const edge = this.edgeMap.get(id)!
      return { ...edge, attributes: cloneAttributes(edge.attributes, `edge[${id}].attributes`) }
    })
  }
  relationKindsBetween(source: string, target: string): string[] {
    return [...new Set(
      this.edgesBetween(source, target)
        .map((edge) => edge.attributes.relation)
        .filter((relation): relation is string => typeof relation === 'string' && relation.length > 0),
    )].sort()
  }
  bestRelationBetween(
    source: string,
    target: string,
    accepts: (relation: string) => boolean = () => true,
    score: (relation: string) => number = () => 0,
  ): string | undefined {
    return this.relationKindsBetween(source, target)
      .filter(accepts)
      .sort((left, right) => score(right) - score(left) || compareCodeUnits(left, right))[0]
  }
  hasMatchingRelationBetween(source: string, target: string, accepts: (relation: string) => boolean): boolean {
    return this.relationKindsBetween(source, target).some(accepts)
  }
  uniqueEdgeBetween(source: string, target: string): GraphEdge {
    const edges = this.edgesBetween(source, target)
    if (edges.length !== 1) throw new Error(`Expected one graph edge for ${source} -> ${target}, found ${edges.length}; use edgesBetween() for multigraph traversal`)
    return edges[0]!
  }
  successors(id: string): string[] { return sorted(this.successorMap.get(id) ?? []) }
  predecessors(id: string): string[] { return sorted(this.predecessorMap.get(id) ?? []) }
  incidentNeighbors(id: string, limit = Number.POSITIVE_INFINITY): string[] {
    const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY
    const successors = this.successors(id)
    const predecessors = this.predecessors(id)
    const result: string[] = []
    const seen = new Set<string>()
    const length = Math.max(successors.length, predecessors.length)
    for (let index = 0; result.length < boundedLimit && index < length; index += 1) {
      for (const candidate of [successors[index], predecessors[index]]) {
        if (candidate === undefined || seen.has(candidate)) continue
        seen.add(candidate)
        result.push(candidate)
        if (result.length >= boundedLimit) break
      }
    }
    return result
  }
  degree(id: string): number {
    let degree = 0
    for (const edge of this.edgeMap.values()) {
      if (edge.source === id) degree += 1
      if (edge.target === id) degree += 1
    }
    return degree
  }
  nodeAttributes(id: string): GraphAttributes {
    const attributes = this.nodeMap.get(id)
    if (!attributes) throw new Error(`Unknown node: ${id}`)
    return cloneAttributes(attributes, `node[${JSON.stringify(id)}].attributes`)
  }
}
