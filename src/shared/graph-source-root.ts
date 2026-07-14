import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import { resolveWorkspaceGraphPath } from './workspace.js'

interface GraphRootCarrier {
  graph?: {
    root_path?: unknown
  }
}

/**
 * Returns the source workspace recorded in a graph. New graphs always carry
 * `root_path`; the path-based fallback preserves compatibility with older
 * `<project>/out/graph.json` artifacts.
 */
export function resolveGraphSourceRoot(graphPath: string, graph?: GraphRootCarrier): string {
  const storedRoot = graph?.graph?.root_path
  if (typeof storedRoot === 'string' && storedRoot.trim().length > 0) {
    return resolve(storedRoot.trim())
  }

  const graphDirectory = dirname(resolve(graphPath))
  return basename(graphDirectory) === 'out' ? dirname(graphDirectory) : graphDirectory
}

/** Reads just enough of graph.json to resolve its recorded source workspace. */
export function readGraphSourceRoot(graphPath: string): string {
  const resolvedGraphPath = resolveWorkspaceGraphPath(graphPath)
  try {
    const parsed = JSON.parse(readFileSync(resolvedGraphPath, 'utf8')) as { root_path?: unknown }
    return resolveGraphSourceRoot(resolvedGraphPath, { graph: { root_path: parsed.root_path } })
  } catch {
    return resolveGraphSourceRoot(resolvedGraphPath)
  }
}
