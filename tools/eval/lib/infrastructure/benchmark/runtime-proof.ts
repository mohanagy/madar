import { realpathSync } from 'node:fs'

import { retrieveContext } from '../../../../../src/application/retrieve-context.js'
import type { KnowledgeGraph } from '../../../../../src/domain/graph/directed-multigraph.js'
import { inspectQueryIndex } from '../../../../../src/domain/query/index-status.js'
import type { RetrieveContextResult } from '../../../../../src/domain/query/types.js'
import { readGraphSourceRoot } from '../../shared/graph-source-root.js'

/**
 * Runs the production evidence query for an evaluation graph.
 *
 * Benchmark artifacts may store a relative source root, so evaluation runs
 * from the authenticated graph root while the application use case resolves
 * source excerpts. Evaluation does not add another retrieval implementation.
 */
export function retrieveBenchmarkContext(
  graph: KnowledgeGraph,
  graphPath: string,
  question: string,
  budget: number,
): RetrieveContextResult {
  const projectRoot = realpathSync(readGraphSourceRoot(graphPath))
  const originalCwd = process.cwd()
  try {
    process.chdir(projectRoot)
    return retrieveContext(inspectQueryIndex(graph), { question, budget })
  } finally {
    process.chdir(originalCwd)
  }
}
