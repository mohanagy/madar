import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'
import {
  KnowledgeGraph,
  type GraphAttributes,
} from '../../src/domain/graph/directed-multigraph.js'

interface TestGraphSpec {
  metadata?: GraphAttributes
  nodes?: ReadonlyArray<readonly [id: string, attributes: GraphAttributes]>
  edges?: ReadonlyArray<readonly [source: string, target: string, attributes: GraphAttributes]>
}

export function createTestGraph(spec: TestGraphSpec): KnowledgeGraph {
  const graph = new KnowledgeGraph(spec.metadata)
  for (const [id, attributes] of spec.nodes ?? []) graph.addNode(id, attributes)
  for (const [source, target, attributes] of spec.edges ?? []) graph.addEdge(source, target, attributes)
  return graph
}

export function buildCanonicalTestGraph(input: {
  root: string
  files: readonly string[]
}): KnowledgeGraph {
  return buildCanonicalTypeScriptIndex(input).graph
}
