import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  GRAPH_LOCAL_SIDECAR_BASENAME,
  loadGraphArtifact,
  parseGraphArtifactV2,
} from '../contracts/graph-artifact.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'
import { syncDirectory, temporaryPath, writeDurableTemporaryFile } from './durable-file.js'

export { GRAPH_ARTIFACT_V2_TOMBSTONE }

export interface GraphArtifactActivationResult {
  readonly outputDir: string
  readonly artifactPath: string
  readonly legacyBackupPath: string
  readonly tombstonePath: string
  readonly legacyBackupCreated: boolean
  /** Null when no source root was supplied. */
  readonly sidecarPath: string | null
}

export type GraphArtifactActivationStep =
  | 'write_v2_temp'
  | 'write_v1_backup_temp'
  | 'write_tombstone_temp'
  | 'write_sidecar_temp'
  | 'rename_sidecar'
  | 'rename_v2'
  | 'rename_v1_backup'
  | 'rename_tombstone'

export type GraphArtifactActivationPhase = 'v2_activated' | 'v1_preserved'

export interface GraphArtifactActivationOptions {
  /**
   * Absolute machine-local source root recorded in the sidecar.
   *
   * Omitted when unknown, in which case no sidecar is published. The sidecar
   * is derived, machine-local data, so it is never restored during an unwind.
   */
  readonly sidecarRootPath?: string
  /** Filesystem-boundary fault injection used by the activation safety suite. */
  readonly beforeStep?: (step: GraphArtifactActivationStep) => void
  /** Simulates an acknowledgement failure after an atomic rename is visible. */
  readonly afterRename?: (step: Extract<GraphArtifactActivationStep, `rename_${string}`>) => void
  /** Simulates process interruption after a visible, independently safe phase. */
  readonly interruptAfterPhase?: GraphArtifactActivationPhase
}

export class GraphArtifactActivationInterruptedError extends Error {
  constructor(readonly phase: GraphArtifactActivationPhase) {
    super(`Graph artifact activation interrupted after ${phase}`)
    this.name = 'GraphArtifactActivationInterruptedError'
  }
}

export class GraphArtifactBackupConflictError extends Error {
  constructor(readonly backupPath: string) {
    super(`Refusing to overwrite a different preserved legacy graph artifact at ${backupPath}`)
    this.name = 'GraphArtifactBackupConflictError'
  }
}

interface FileSnapshot {
  readonly bytes: Buffer | null
}

function snapshot(path: string): FileSnapshot {
  return { bytes: existsSync(path) ? readFileSync(path) : null }
}

function restoreSnapshot(outputDir: string, path: string, state: FileSnapshot, label: string): void {
  if (state.bytes === null) {
    rmSync(path, { force: true })
    syncDirectory(outputDir)
    return
  }
  const temporary = temporaryPath(outputDir, `rollback-${label}`)
  try {
    writeDurableTemporaryFile(temporary, state.bytes)
    renameSync(temporary, path)
    syncDirectory(outputDir)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function validLegacyArtifact(bytes: Uint8Array): boolean {
  try {
    return loadGraphArtifact(bytes).format === 'v1'
  } catch {
    return false
  }
}

export function activateGraphArtifactV2(
  workspaceRoot: string,
  artifactBytes: Uint8Array,
  options: GraphArtifactActivationOptions = {},
): GraphArtifactActivationResult {
  parseGraphArtifactV2(artifactBytes)
  const outputDir = resolveMadarOutputDirectory(workspaceRoot)
  mkdirSync(outputDir, { recursive: true })
  const artifactPath = join(outputDir, 'graph.madar')
  const legacyBackupPath = join(outputDir, 'graph.v1.json')
  const tombstonePath = join(outputDir, 'graph.json')
  const existingGraph = existsSync(tombstonePath) ? readFileSync(tombstonePath) : null
  const legacyToPreserve = existingGraph !== null && validLegacyArtifact(existingGraph)
    ? existingGraph
    : null
  const existingLegacyBackup = existsSync(legacyBackupPath) ? readFileSync(legacyBackupPath) : null
  if (
    legacyToPreserve !== null
    && existingLegacyBackup !== null
    && !existingLegacyBackup.equals(legacyToPreserve)
  ) {
    throw new GraphArtifactBackupConflictError(legacyBackupPath)
  }
  const createLegacyBackup = legacyToPreserve !== null && existingLegacyBackup === null
  const artifactSnapshot = snapshot(artifactPath)
  const legacyBackupSnapshot = snapshot(legacyBackupPath)
  const tombstoneSnapshot = snapshot(tombstonePath)
  const sidecarRootPath = options.sidecarRootPath?.trim()
  const sidecarPath = sidecarRootPath !== undefined && sidecarRootPath.length > 0
    ? join(outputDir, GRAPH_LOCAL_SIDECAR_BASENAME)
    : null

  const artifactTemp = temporaryPath(outputDir, 'graph-v2')
  const legacyBackupTemp = createLegacyBackup ? temporaryPath(outputDir, 'graph-v1-backup') : null
  const tombstoneTemp = temporaryPath(outputDir, 'graph-tombstone')
  const sidecarTemp = sidecarPath === null ? null : temporaryPath(outputDir, 'graph-local')

  let artifactActivated = false
  let legacyBackupActivated = false
  let tombstoneActivated = false
  try {
    options.beforeStep?.('write_v2_temp')
    writeDurableTemporaryFile(artifactTemp, artifactBytes)
    if (legacyBackupTemp !== null && legacyToPreserve !== null) {
      options.beforeStep?.('write_v1_backup_temp')
      writeDurableTemporaryFile(legacyBackupTemp, legacyToPreserve)
    }
    options.beforeStep?.('write_tombstone_temp')
    writeDurableTemporaryFile(tombstoneTemp, GRAPH_ARTIFACT_V2_TOMBSTONE)
    if (sidecarTemp !== null) {
      options.beforeStep?.('write_sidecar_temp')
      writeDurableTemporaryFile(sidecarTemp, `${JSON.stringify({ root_path: sidecarRootPath }, null, 2)}\n`)
    }

    /*
     * Activation order and crash contract:
     *   1. Rename and directory-fsync the machine-local sidecar, when present.
     *   2. Rename and directory-fsync graph.madar.
     *   3. Preserve and directory-fsync graph.v1.json when a valid prior v1 exists.
     *   4. Rename and directory-fsync the graph.json tombstone last.
     * All bytes are staged before step 1. Ordinary failures roll steps 2/3
     * back to their exact snapshots. A process interruption after step 2 or 3
     * is independently safe: old readers still see legacy JSON, while the new
     * path loader prefers the already-durable sibling graph.madar. The only
     * legacy graph.json is never replaced before its backup is durable.
     *
     * The sidecar goes first because it only records where the source root is.
     * It is derived and machine-local, so an early sidecar cannot mislead a
     * reader about graph content, and it is deliberately not rolled back.
     */
    if (sidecarTemp !== null && sidecarPath !== null) {
      options.beforeStep?.('rename_sidecar')
      renameSync(sidecarTemp, sidecarPath)
      options.afterRename?.('rename_sidecar')
      syncDirectory(outputDir)
    }

    options.beforeStep?.('rename_v2')
    renameSync(artifactTemp, artifactPath)
    artifactActivated = true
    options.afterRename?.('rename_v2')
    syncDirectory(outputDir)
    if (options.interruptAfterPhase === 'v2_activated') {
      throw new GraphArtifactActivationInterruptedError('v2_activated')
    }

    if (legacyBackupTemp !== null) {
      options.beforeStep?.('rename_v1_backup')
      renameSync(legacyBackupTemp, legacyBackupPath)
      legacyBackupActivated = true
      options.afterRename?.('rename_v1_backup')
      syncDirectory(outputDir)
    }
    if (options.interruptAfterPhase === 'v1_preserved') {
      throw new GraphArtifactActivationInterruptedError('v1_preserved')
    }

    options.beforeStep?.('rename_tombstone')
    renameSync(tombstoneTemp, tombstonePath)
    tombstoneActivated = true
    options.afterRename?.('rename_tombstone')
    syncDirectory(outputDir)
  } catch (error) {
    if (!(error instanceof GraphArtifactActivationInterruptedError)) {
      if (tombstoneActivated) {
        restoreSnapshot(outputDir, tombstonePath, tombstoneSnapshot, 'graph-tombstone')
      }
      if (legacyBackupActivated) {
        restoreSnapshot(outputDir, legacyBackupPath, legacyBackupSnapshot, 'graph-v1')
      }
      if (artifactActivated) {
        restoreSnapshot(outputDir, artifactPath, artifactSnapshot, 'graph-v2')
      }
    }
    throw error
  } finally {
    rmSync(artifactTemp, { force: true })
    if (legacyBackupTemp !== null) rmSync(legacyBackupTemp, { force: true })
    rmSync(tombstoneTemp, { force: true })
    if (sidecarTemp !== null) rmSync(sidecarTemp, { force: true })
  }

  return {
    outputDir,
    artifactPath,
    legacyBackupPath,
    tombstonePath,
    legacyBackupCreated: createLegacyBackup,
    sidecarPath,
  }
}
