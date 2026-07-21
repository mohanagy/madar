import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { resolveWorkspaceGraphPath } from './workspace.js'

interface GraphRootCarrier {
  graph?: {
    root_path?: unknown
  }
}

/**
 * Returns the source workspace recorded in a graph. Canonical artifacts
 * normally carry `root_path`; in-memory graphs without it retain the
 * path-based workspace inference used by programmatic callers.
 */
export function resolveGraphSourceRoot(graphPath: string, graph?: GraphRootCarrier): string {
  const storedRoot = graph?.graph?.root_path
  if (typeof storedRoot === 'string' && storedRoot.trim().length > 0) {
    return resolve(storedRoot.trim())
  }

  const graphDirectory = dirname(resolve(graphPath))
  return basename(graphDirectory) === 'out' ? dirname(graphDirectory) : graphDirectory
}

/**
 * Resolves the source workspace from canonical metadata when an artifact exists.
 * Pure path callers may pass a prospective graph path, so a missing artifact
 * retains deterministic path inference. Existing artifacts are always parsed
 * strictly; legacy or corrupt files must be regenerated.
 */
export function readGraphSourceRoot(graphPath: string): string {
  const resolvedGraphPath = resolveWorkspaceGraphPath(graphPath)
  if (!existsSync(resolvedGraphPath)) {
    return resolveGraphSourceRoot(resolvedGraphPath)
  }
  return resolveGraphSourceRoot(resolvedGraphPath, loadGraphArtifact(resolvedGraphPath))
}
