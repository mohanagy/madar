import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { GRAPH_LOCAL_SIDECAR_BASENAME, parseGraphArtifactV2 } from '../contracts/graph-artifact.js'
import { syncDirectory, temporaryPath, writeDurableTemporaryFile } from './durable-file.js'

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

function snapshot(path: string): Uint8Array | null {
  return existsSync(path) ? readFileSync(path) : null
}

/**
 * Puts a file back through the same staged-and-renamed route used to publish
 * it. Writing the previous bytes directly over the live path would leave a
 * torn file visible if the restore itself failed -- during an unwind, which is
 * already the failure path.
 */
function restore(outputDir: string, path: string, previous: Uint8Array | null): void {
  if (previous === null) {
    rmSync(path, { force: true })
    syncDirectory(outputDir)
    return
  }
  const temporary = temporaryPath(outputDir, 'restore')
  try {
    writeDurableTemporaryFile(temporary, previous)
    renameSync(temporary, path)
    syncDirectory(outputDir)
  } finally {
    rmSync(temporary, { force: true })
  }
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

  // Unique per process and per run. A fixed ".publishing" suffix meant two
  // concurrent generations into one output directory staged over each other,
  // and the winner renamed the loser's bytes into place as its own.
  const artifactTemp = temporaryPath(input.outputDir, 'graph-madar')
  const legacyTemp = temporaryPath(input.outputDir, 'graph-json')
  const sidecarTemp = sidecarPath === null ? null : temporaryPath(input.outputDir, 'graph-local')

  const previousArtifact = snapshot(artifactPath)
  const previousLegacy = snapshot(legacyMirrorPath)

  let artifactCommitted = false
  try {
    input.beforeStep?.('stage')
    writeDurableTemporaryFile(artifactTemp, input.artifactBytes)
    writeDurableTemporaryFile(legacyTemp, input.legacyJson)
    if (sidecarTemp !== null && sidecarPath !== null) {
      writeDurableTemporaryFile(sidecarTemp, `${JSON.stringify({ root_path: input.rootPath }, null, 2)}\n`)
    }

    input.beforeStep?.('rename_canonical')
    renameSync(artifactTemp, artifactPath)
    artifactCommitted = true
    syncDirectory(input.outputDir)
    input.beforeStep?.('rename_mirror')
    renameSync(legacyTemp, legacyMirrorPath)
    syncDirectory(input.outputDir)
    if (sidecarTemp !== null && sidecarPath !== null) {
      renameSync(sidecarTemp, sidecarPath)
      syncDirectory(input.outputDir)
    }
  } catch (error) {
    // Best-effort reverse unwind for catchable failures. This cannot protect
    // against abrupt termination -- see the publication contract above.
    // The sidecar is machine-local and derived, so it is not restored.
    if (artifactCommitted) restore(input.outputDir, artifactPath, previousArtifact)
    restore(input.outputDir, legacyMirrorPath, previousLegacy)
    for (const temp of [artifactTemp, legacyTemp, sidecarTemp]) {
      if (temp !== null) rmSync(temp, { force: true })
    }
    throw error
  }

  return Object.freeze({ artifactPath, legacyMirrorPath, sidecarPath })
}
