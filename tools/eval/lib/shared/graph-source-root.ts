import { resolve } from 'node:path'

import { loadGraphArtifact } from '../../../../src/adapters/filesystem/graph-artifact.js'
import { readBuildState } from '../../../../src/domain/index/build-state.js'
import { resolveWorkspaceGraphPath } from '../../../../src/shared/workspace.js'

export function readGraphSourceRoot(graphPath: string): string {
  const resolvedGraphPath = resolveWorkspaceGraphPath(graphPath)
  const state = readBuildState(loadGraphArtifact(resolvedGraphPath))
  if (!state) throw new Error('Canonical graph has no authenticated v3 build state')
  return resolve(state.source_root.root_path)
}
