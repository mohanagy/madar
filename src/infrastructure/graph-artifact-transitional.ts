import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'

import { GRAPH_LOCAL_SIDECAR_BASENAME, parseGraphArtifactV2 } from '../contracts/graph-artifact.js'

/**
 * Transitional dual-artifact publish for PR B1.
 *
 * B1 activates artifact v2 without demoting the legacy path: `graph.madar`
 * becomes the canonical artifact that new readers prefer, while `graph.json`
 * stays a fresh v1 mirror regenerated from the same graph on the same run, so
 * existing readers, the HTTP route, the MCP resource and several hundred test
 * assertions keep working unchanged.
 *
 * The tombstone cutover is a separate, separately reviewable migration. It is
 * NOT performed here; `activateGraphArtifactV2` remains a prepared migration
 * primitive that no production path calls until then.
 *
 * The two artifacts are committed together. Publishing them through
 * independent writes would let a crash between the two leave a current
 * `graph.json` beside a stale `graph.madar` -- two files describing different
 * revisions, with nothing to indicate which one a reader should distrust.
 */
export interface TransitionalGraphArtifactInput {
  readonly outputDir: string
  readonly artifactBytes: Uint8Array
  readonly legacyJson: string
  /** Absolute machine-local workspace root; omitted when unknown. */
  readonly rootPath?: string
}

export interface TransitionalGraphArtifactResult {
  readonly artifactPath: string
  readonly legacyMirrorPath: string
  readonly sidecarPath: string | null
}

function writeDurable(path: string, contents: Uint8Array | string): void {
  writeFileSync(path, contents)
  const handle = openSync(path, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

function snapshot(path: string): Uint8Array | null {
  return existsSync(path) ? readFileSync(path) : null
}

function restore(path: string, previous: Uint8Array | null): void {
  if (previous === null) {
    rmSync(path, { force: true })
    return
  }
  writeDurable(path, previous)
}

/**
 * Validates the candidate, stages every file, then commits by rename.
 *
 * Validation happens before anything is staged: an artifact that cannot be
 * parsed must never reach the output directory, even briefly.
 */
export function publishTransitionalGraphArtifacts(
  input: TransitionalGraphArtifactInput,
): TransitionalGraphArtifactResult {
  parseGraphArtifactV2(input.artifactBytes)

  mkdirSync(input.outputDir, { recursive: true })
  const artifactPath = join(input.outputDir, 'graph.madar')
  const legacyMirrorPath = join(input.outputDir, 'graph.json')
  const sidecarPath = input.rootPath !== undefined && input.rootPath.trim().length > 0
    ? join(input.outputDir, GRAPH_LOCAL_SIDECAR_BASENAME)
    : null

  const artifactTemp = `${artifactPath}.publishing`
  const legacyTemp = `${legacyMirrorPath}.publishing`
  const sidecarTemp = sidecarPath === null ? null : `${sidecarPath}.publishing`

  const previousArtifact = snapshot(artifactPath)
  const previousLegacy = snapshot(legacyMirrorPath)

  let artifactCommitted = false
  try {
    writeDurable(artifactTemp, input.artifactBytes)
    writeDurable(legacyTemp, input.legacyJson)
    if (sidecarTemp !== null && sidecarPath !== null) {
      writeDurable(sidecarTemp, `${JSON.stringify({ root_path: input.rootPath }, null, 2)}\n`)
    }

    renameSync(artifactTemp, artifactPath)
    artifactCommitted = true
    renameSync(legacyTemp, legacyMirrorPath)
    if (sidecarTemp !== null && sidecarPath !== null) {
      renameSync(sidecarTemp, sidecarPath)
    }
  } catch (error) {
    // Unwind in reverse so the pair never survives half-committed. The sidecar
    // is machine-local and derived, so it is not restored.
    if (artifactCommitted) restore(artifactPath, previousArtifact)
    restore(legacyMirrorPath, previousLegacy)
    for (const temp of [artifactTemp, legacyTemp, sidecarTemp]) {
      if (temp !== null) rmSync(temp, { force: true })
    }
    throw error
  }

  return Object.freeze({ artifactPath, legacyMirrorPath, sidecarPath })
}
