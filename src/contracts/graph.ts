export type GraphAttributes = Record<string, unknown>

export type GraphRelationshipView = Readonly<GraphAttributes>

export type GraphRelationshipEntry = readonly [
  source: string,
  target: string,
  attributes: GraphRelationshipView,
]

export interface GraphEndpointEntry {
  readonly source: string
  readonly target: string
}

export interface FactsBetweenOptions {
  readonly relations?: readonly string[]
}

export interface KnowledgeGraphOptions {
  directed?: boolean
}

interface StoredEdge {
  source: string
  target: string
  attributes: GraphAttributes
}

function immutableGraphValue(value: unknown, clones = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }

  const existing = clones.get(value)
  if (existing !== undefined) {
    return existing
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = []
    clones.set(value, clone)
    clone.push(...value.map((item) => immutableGraphValue(item, clones)))
    return Object.freeze(clone)
  }

  if (value instanceof Date || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) {
    return structuredClone(value)
  }

  const clone: Record<string, unknown> = {}
  clones.set(value, clone)
  for (const [key, item] of Object.entries(value)) {
    clone[key] = immutableGraphValue(item, clones)
  }
  return Object.freeze(clone)
}

function immutableGraphAttributes(attributes: GraphAttributes): GraphRelationshipView {
  return immutableGraphValue(attributes) as GraphRelationshipView
}

export class KnowledgeGraph {
  public readonly graph: GraphAttributes = {}
  public readonly directed: boolean

  private readonly nodeMap = new Map<string, GraphAttributes>()
  private readonly edgeMap = new Map<string, StoredEdge>()
  private readonly successorMap = new Map<string, Set<string>>()
  private readonly predecessorMap = new Map<string, Set<string>>()

  constructor(options: KnowledgeGraphOptions | boolean = {}) {
    this.directed = typeof options === 'boolean' ? options : options.directed === true
    this.graph.directed = this.directed
  }

  private edgeKey(source: string, target: string): string {
    if (this.directed) {
      return `${source}\u0000${target}`
    }
    return [source, target].sort().join('\u0000')
  }

  addNode(id: string, attributes: GraphAttributes): void {
    this.nodeMap.set(id, { ...attributes })
    if (!this.successorMap.has(id)) {
      this.successorMap.set(id, new Set())
    }
    if (!this.predecessorMap.has(id)) {
      this.predecessorMap.set(id, new Set())
    }
  }

  addEdge(source: string, target: string, attributes: GraphAttributes): void {
    if (!this.nodeMap.has(source)) {
      this.addNode(source, {})
    }
    if (!this.nodeMap.has(target)) {
      this.addNode(target, {})
    }

    const key = this.edgeKey(source, target)
    this.edgeMap.set(key, {
      source,
      target,
      attributes: { ...attributes },
    })

    this.successorMap.get(source)?.add(target)
    this.predecessorMap.get(target)?.add(source)

    if (!this.directed) {
      this.successorMap.get(target)?.add(source)
      this.predecessorMap.get(source)?.add(target)
    }
  }

  isDirected(): boolean {
    return this.directed
  }

  hasNode(id: string): boolean {
    return this.nodeMap.has(id)
  }

  numberOfNodes(): number {
    return this.nodeMap.size
  }

  /** Returns the number of semantic relationships represented by the current store. */
  numberOfFacts(): number {
    return this.edgeMap.size
  }

  /** Returns the number of unique endpoint pairs represented by the current store. */
  numberOfEndpointPairs(): number {
    return this.edgeMap.size
  }

  /** @deprecated Use numberOfFacts() or numberOfEndpointPairs() to state the intended semantics. */
  numberOfEdges(): number {
    return this.numberOfFacts()
  }

  /** Returns whether at least one relationship exists between the endpoints. */
  hasEdge(source: string, target: string): boolean {
    return this.edgeMap.has(this.edgeKey(source, target))
  }

  nodeIds(): string[] {
    return [...this.nodeMap.keys()]
  }

  nodeEntries(): Array<[string, GraphAttributes]> {
    return [...this.nodeMap.entries()].map(([id, attributes]) => [id, { ...attributes }])
  }

  /**
   * Returns every semantic relationship in deterministic insertion order.
   * Relationship views and the returned collection cannot mutate graph state.
   */
  factEntries(): readonly GraphRelationshipEntry[] {
    return Object.freeze([...this.edgeMap.values()].map(({ source, target, attributes }) => Object.freeze([
      source,
      target,
      immutableGraphAttributes(attributes),
    ] as const)))
  }

  /** Returns unique endpoint pairs in deterministic insertion order. */
  endpointEntries(): readonly GraphEndpointEntry[] {
    return Object.freeze([...this.edgeMap.values()].map(({ source, target }) => Object.freeze({ source, target })))
  }

  /** @deprecated Use factEntries() for relationships or endpointEntries() for topology. */
  edgeEntries(): Array<[string, string, GraphAttributes]> {
    return [...this.edgeMap.values()].map(({ source, target, attributes }) => [source, target, { ...attributes }])
  }

  /** Returns unique outgoing neighbors in stable insertion order. */
  neighbors(id: string): string[] {
    return [...(this.successorMap.get(id) ?? [])]
  }

  /** Returns unique successors in stable insertion order. */
  successors(id: string): string[] {
    return this.neighbors(id)
  }

  /** Returns unique predecessors in stable insertion order. */
  predecessors(id: string): string[] {
    return [...(this.predecessorMap.get(id) ?? [])]
  }

  incidentNeighbors(id: string, limit = Number.POSITIVE_INFINITY): string[] {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : Number.POSITIVE_INFINITY
    if (boundedLimit === 0) {
      return []
    }

    const neighbors: string[] = []
    const seen = new Set<string>()
    const successors = (this.successorMap.get(id) ?? new Set()).values()
    const predecessors = (this.predecessorMap.get(id) ?? new Set()).values()
    let successorsDone = false
    let predecessorsDone = false

    const appendNext = (iterator: SetIterator<string>): boolean => {
      const next = iterator.next()
      if (next.done) {
        return true
      }
      if (!seen.has(next.value)) {
        seen.add(next.value)
        neighbors.push(next.value)
      }
      return false
    }

    // Alternate directions so a bounded incident scan cannot starve all
    // callers or all callees on a directed high-degree node.
    while (neighbors.length < boundedLimit && (!successorsDone || !predecessorsDone)) {
      if (!successorsDone) {
        successorsDone = appendNext(successors)
      }
      if (neighbors.length >= boundedLimit) {
        break
      }
      if (!predecessorsDone) {
        predecessorsDone = appendNext(predecessors)
      }
    }
    return neighbors
  }

  /** Returns the number of unique incident neighbors for a node. */
  uniqueNeighborDegree(id: string): number {
    return this.incidentNeighbors(id).length
  }

  /** @deprecated Use uniqueNeighborDegree() to state the intended topology semantics. */
  degree(id: string): number {
    return this.uniqueNeighborDegree(id)
  }

  nodeAttributes(id: string): GraphAttributes {
    const attributes = this.nodeMap.get(id)
    if (!attributes) {
      throw new Error(`Unknown node: ${id}`)
    }
    return { ...attributes }
  }

  /**
   * Returns every semantic relationship between two endpoints.
   * The current endpoint-keyed store projects zero or one item; callers must accept many.
   */
  factsBetween(
    source: string,
    target: string,
    options: FactsBetweenOptions = {},
  ): readonly GraphRelationshipView[] {
    const edge = this.edgeMap.get(this.edgeKey(source, target))
    if (!edge) {
      return Object.freeze([])
    }

    const relation = String(edge.attributes.relation ?? '')
    if (options.relations && !new Set(options.relations).has(relation)) {
      return Object.freeze([])
    }

    return Object.freeze([immutableGraphAttributes(edge.attributes)])
  }

  /** Returns unique relation values between two endpoints in stable fact order. */
  relationsBetween(source: string, target: string): readonly string[] {
    const relations = new Set<string>()
    for (const fact of this.factsBetween(source, target)) {
      relations.add(String(fact.relation ?? ''))
    }
    return Object.freeze([...relations])
  }

  /** @deprecated Use factsBetween() and process every returned relationship explicitly. */
  edgeAttributes(source: string, target: string): GraphAttributes {
    const edge = this.edgeMap.get(this.edgeKey(source, target))
    if (!edge) {
      throw new Error(`Unknown edge: ${source} ${this.directed ? '->' : '<->'} ${target}`)
    }
    return { ...edge.attributes }
  }
}
