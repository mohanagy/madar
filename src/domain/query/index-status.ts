import {
  KnowledgeGraph,
  type GraphAttributes,
  type GraphEdge,
} from '../graph/directed-multigraph.js'
import { CANONICAL_INDEX_FORMAT_VERSION, readBuildState, type SourceSnapshotEntry } from '../index/build-state.js'

export interface QueryGraph {
  hasNode(id: string): boolean; hasEdge(source: string, target: string): boolean
  nodeEntries(): Array<[string, GraphAttributes]>
  edgeEntries(): Array<[string, string, GraphAttributes, string]>
  predecessors(id: string): string[]; successors(id: string): string[]
  edgesBetween(source: string, target: string): GraphEdge[]; nodeAttributes(id: string): GraphAttributes
}

export interface ReadyQueryIndex {
  state: 'ready'; graph: QueryGraph; root_path: string
  file_hashes: ReadonlyMap<string, string>; unsupported_sources: readonly SourceSnapshotEntry[]
}

export interface FailedQueryIndex { state: 'unavailable' | 'corrupt'; subject: string }

export type QueryIndex = ReadyQueryIndex | FailedQueryIndex

function immutableMap(entries: Iterable<readonly [string, string]>): ReadonlyMap<string, string> {
  const values = new Map(entries)
  return Object.freeze({
    get size() { return values.size },
    get(key: string) { return values.get(key) },
    has(key: string) { return values.has(key) },
    entries() { return values.entries() },
    keys() { return values.keys() },
    values() { return values.values() },
    forEach(
      callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
      thisArg?: unknown,
    ) {
      values.forEach((value, key) => callback.call(thisArg, value, key, this))
    },
    [Symbol.iterator]() { return values[Symbol.iterator]() },
  }) as ReadonlyMap<string, string>
}

function graphSnapshot(source: KnowledgeGraph): KnowledgeGraph {
  const snapshot = new KnowledgeGraph(source.graph)
  for (const [id, attributes] of source.nodeEntries()) snapshot.addNode(id, attributes)
  for (const [from, to, attributes, expectedId] of source.edgeEntries()) {
    const id = snapshot.addEdge(from, to, attributes)
    if (id !== expectedId) throw new Error('Canonical graph edge identity changed while sealing query index')
  }
  return snapshot
}

function immutableQueryGraph(snapshot: KnowledgeGraph): QueryGraph {
  return Object.freeze({
    hasNode: (id: string) => snapshot.hasNode(id),
    hasEdge: (source: string, target: string) => snapshot.hasEdge(source, target),
    nodeEntries: () => snapshot.nodeEntries(),
    edgeEntries: () => snapshot.edgeEntries(),
    predecessors: (id: string) => snapshot.predecessors(id),
    successors: (id: string) => snapshot.successors(id),
    edgesBetween: (source: string, target: string) => snapshot.edgesBetween(source, target),
    nodeAttributes: (id: string) => snapshot.nodeAttributes(id),
  })
}

export function failedQueryIndex(state: FailedQueryIndex['state'], subject: string): FailedQueryIndex {
  return { state, subject }
}

export function inspectQueryIndex(graph: KnowledgeGraph): QueryIndex {
  let snapshot: KnowledgeGraph
  try {
    snapshot = graphSnapshot(graph)
  } catch {
    return failedQueryIndex('corrupt', 'canonical graph snapshot')
  }
  const build = readBuildState(snapshot)
  const root = snapshot.graph.root_path
  if (!build || snapshot.graph.canonical_typescript_index !== true
    || snapshot.graph.schema_version !== CANONICAL_INDEX_FORMAT_VERSION
    || typeof root !== 'string' || root.trim().length === 0
    || build.source_root.root_path !== root) {
    return failedQueryIndex('corrupt', 'canonical TypeScript index metadata')
  }
  if (build.completeness.summary.state !== 'complete'
    || build.completeness.supported_failures.length > 0) {
    return failedQueryIndex('unavailable', 'canonical TypeScript index incomplete')
  }

  const hashes = new Map<string, string>()
  for (const [, attributes] of snapshot.nodeEntries()) {
    if (attributes.node_kind !== 'file') continue
    const sourceFile = attributes.source_file
    const contentHash = attributes.content_hash
    if (typeof sourceFile !== 'string' || typeof contentHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(contentHash)) {
      return failedQueryIndex('corrupt', 'canonical file-node hash')
    }
    if (hashes.has(sourceFile)) {
      return failedQueryIndex('corrupt', sourceFile)
    }
    hashes.set(sourceFile, contentHash)
  }

  if (hashes.size !== build.sources.supported.length
    || build.sources.supported.some((source) => hashes.get(source.path) !== source.hash)) {
    return failedQueryIndex('corrupt', 'canonical file-node coverage')
  }

  return Object.freeze({
    state: 'ready', graph: immutableQueryGraph(snapshot), root_path: root,
    file_hashes: immutableMap(hashes),
    unsupported_sources: Object.freeze(build.sources.unsupported.map((source) => Object.freeze({ ...source }))),
  })
}
