import { resolve } from 'node:path'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../application/generate-index.js'
import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../application/retrieve-context.js'
import { inspectQueryIndex } from '../domain/query/index-status.js'

interface TryCliOptions {
  question: string
  path: string
}

export interface TryCommandDependencies {
  generateGraph: typeof generateIndex
  loadGraph: typeof loadGraphArtifact
  inspectQueryIndex: typeof inspectQueryIndex
  retrieveContext: typeof retrieveContext
}

const DEFAULT_DEPENDENCIES: TryCommandDependencies = {
  generateGraph: generateIndex,
  loadGraph: loadGraphArtifact,
  inspectQueryIndex,
  retrieveContext,
}

/**
 * Builds the canonical index and runs the same evidence query used by CLI/MCP.
 *
 * It intentionally performs one generation and one production query.
 */
export function runTryCommand(
  options: TryCliOptions,
  dependencies: TryCommandDependencies = DEFAULT_DEPENDENCIES,
): string {
  const generated = dependencies.generateGraph(resolve(options.path), {})
  const graph = dependencies.loadGraph(generated.graphPath)
  const result = dependencies.retrieveContext(
    dependencies.inspectQueryIndex(graph),
    { question: options.question },
  )

  return [
    `[madar try] Built ${generated.graphPath} with ${generated.nodeCount} nodes.`,
    serializeRetrieveContextResult(result),
  ].join('\n')
}
