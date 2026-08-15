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
 * Publication contract, stated precisely because two filesystem paths cannot
 * be renamed as one transaction:
 *
 * - On successful completion both files come from the same graph and the same
 *   generation run.
 * - Candidate validation happens before either rename, so an unparseable
 *   artifact never reaches the output directory.
 * - A recoverable synchronous failure unwinds in reverse and leaves the
 *   previous usable state.
 * - An abrupt process or machine termination between the two renames may leave
 *   a new `graph.madar` beside the previous `graph.json`. The canonical
 *   artifact can therefore advance ahead of the mirror; the mirror can lag.
 *
 * That asymmetry is deliberate and is why the canonical artifact is renamed
 * FIRST. A lagging mirror is safe because no current reader treats it as the
 * source of truth -- they prefer a valid `graph.madar`. The reverse order would
 * let an advanced mirror be the newest thing on disk, which old readers would
 * consume as authoritative.
 *
 * This is an explicit transitional limitation, allowed on `next` only, and it
 * is removed by the cutover in #705.
 */
export type TransitionalPublicationStep = 'stage' | 'rename_canonical' | 'rename_mirror'

export interface TransitionalGraphArtifactInput {
  readonly outputDir: string
  readonly artifactBytes: Uint8Array
  readonly legacyJson: string
  /** Absolute machine-local workspace root; omitted when unknown. */
  readonly rootPath?: string
  /** Filesystem-boundary fault injection used by the publication safety suite. */
  readonly beforeStep?: (step: TransitionalPublicationStep) => void
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
 * Validates the candidate, stages every file, then publishes canonical-first
 * by rename.
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
    input.beforeStep?.('stage')
    writeDurable(artifactTemp, input.artifactBytes)
    writeDurable(legacyTemp, input.legacyJson)
    if (sidecarTemp !== null && sidecarPath !== null) {
      writeDurable(sidecarTemp, `${JSON.stringify({ root_path: input.rootPath }, null, 2)}\n`)
    }

    input.beforeStep?.('rename_canonical')
    renameSync(artifactTemp, artifactPath)
    artifactCommitted = true
    input.beforeStep?.('rename_mirror')
    renameSync(legacyTemp, legacyMirrorPath)
    if (sidecarTemp !== null && sidecarPath !== null) {
      renameSync(sidecarTemp, sidecarPath)
    }
  } catch (error) {
    // Best-effort reverse unwind for catchable failures. This cannot protect
    // against abrupt termination -- see the publication contract above.
    // The sidecar is machine-local and derived, so it is not restored.
    if (artifactCommitted) restore(artifactPath, previousArtifact)
    restore(legacyMirrorPath, previousLegacy)
    for (const temp of [artifactTemp, legacyTemp, sidecarTemp]) {
      if (temp !== null) rmSync(temp, { force: true })
    }
    throw error
  }

  return Object.freeze({ artifactPath, legacyMirrorPath, sidecarPath })
}
