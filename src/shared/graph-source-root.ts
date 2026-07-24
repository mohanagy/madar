import { resolve } from 'node:path'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { readBuildState } from '../domain/index/build-state.js'
import { resolveWorkspaceGraphPath } from './workspace.js'

export function readGraphSourceRoot(graphPath: string): string {
  const resolvedGraphPath = resolveWorkspaceGraphPath(graphPath)
  const state = readBuildState(loadGraphArtifact(resolvedGraphPath))
  if (!state) throw new Error('Canonical graph has no authenticated v3 build state')
  return resolve(state.source_root.root_path)
}
