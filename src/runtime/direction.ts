import type { KnowledgeGraph } from '../contracts/graph.js'

export class DirectedGraphRequiredError extends Error {
  public readonly code = 'DIRECTED_GRAPH_REQUIRED'

  constructor(operation: string) {
    super(
      `${operation} requires a directed graph because edge orientation is part of the result. `
      + 'Regenerate the workspace graph with `madar generate . --update` (directed is the default).',
    )
    this.name = 'DirectedGraphRequiredError'
  }
}

export function requireDirectedGraph(graph: KnowledgeGraph, operation: string): void {
  if (!graph.isDirected()) {
    throw new DirectedGraphRequiredError(operation)
  }
}
