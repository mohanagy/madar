import { join, resolve } from 'node:path'

import {
  createCanonicalTypeScriptIndexSession,
  type CanonicalTypeScriptIndexSession,
} from '../adapters/typescript/index.js'
import { buildSourceCatalog, type SourceCatalog } from '../adapters/filesystem/source-catalog.js'
import { acquireIndexLease, loadAcceptedIndex } from '../adapters/filesystem/index-store.js'
import {
  buildAndPublishIndex,
  SourceChangedDuringBuildError,
  type GenerateIndexOptions,
  type GenerateIndexResult,
} from './generate-index.js'
import { sourceSnapshotsEqual, type SourceSnapshot, type UpdateReceipt } from '../domain/index/build-state.js'
import { buildDiscoverySafetyMetadata, parseDiscoverySafetyMetadata } from '../shared/discovery-safety.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'

export type UpdateIndexOptions = Omit<GenerateIndexOptions, 'clusterOnly'>
export interface UpdateIndexSession {
  update(options?: UpdateIndexOptions): GenerateIndexResult
}
function changedSupportedFiles(previous: SourceSnapshot, current: SourceSnapshot): string[] {
  const old = new Map(previous.supported.map((entry) => [entry.path, entry.hash]))
  const next = new Map(current.supported.map((entry) => [entry.path, entry.hash]))
  return [...new Set([...old.keys(), ...next.keys()])]
    .filter((path) => old.get(path) !== next.get(path))
    .sort()
}
function controlsChanged(previous: SourceSnapshot, current: SourceSnapshot): boolean {
  const project = (entries: SourceSnapshot['controls']) => JSON.stringify(entries)
  return project(previous.controls) !== project(current.controls)
}
function catalogStillCurrent(catalog: SourceCatalog, options: UpdateIndexOptions): boolean {
  const current = buildSourceCatalog(catalog.rootPath, options)
  return current.policy.fingerprint === catalog.policy.fingerprint
    && sourceSnapshotsEqual(current.snapshot, catalog.snapshot)
}
function acceptedResult(
  rootPath: string,
  accepted: NonNullable<ReturnType<typeof loadAcceptedIndex>>,
  receipt: UpdateReceipt,
): GenerateIndexResult {
  const state = accepted.state
  const outputDir = resolveMadarOutputDirectory(rootPath)
  const communities = new Set(accepted.graph.nodeEntries()
    .map(([, attributes]) => attributes.community)
    .filter((value): value is number => typeof value === 'number' && value >= 0))
  const anomalies = Array.isArray(accepted.graph.graph.semantic_anomalies)
    ? accepted.graph.graph.semantic_anomalies.length : 0
  const safety = parseDiscoverySafetyMetadata(accepted.graph.graph.discovery_safety)
    ?? buildDiscoverySafetyMetadata([])
  return {
    mode: 'update',
    rootPath,
    outputDir,
    graphPath: join(outputDir, 'graph.json'),
    reportPath: join(outputDir, 'GRAPH_REPORT.md'),
    totalFiles: state.corpus.supported_files,
    indexedFiles: state.completeness.summary.counts.indexed + state.completeness.summary.counts.indexed_with_warnings,
    totalWords: state.corpus.total_words,
    nodeCount: accepted.graph.numberOfNodes(),
    edgeCount: accepted.graph.numberOfEdges(),
    communityCount: communities.size,
    semanticAnomalyCount: anomalies,
    warning: state.corpus.warning,
    notes: ['Source snapshot is unchanged; parsing, analysis, and publication were skipped.'],
    discoverySafety: safety,
    indexingManifestPath: join(outputDir, 'indexing-manifest.json'),
    indexing: state.completeness.summary,
    buildId: state.build_id,
    updateReceipt: receipt,
  }
}

export function createUpdateIndexSession(
  rootPath = '.',
  seed?: Pick<GenerateIndexResult, 'buildId' | 'indexSession'>,
): UpdateIndexSession {
  const root = resolve(rootPath)
  let canonical: CanonicalTypeScriptIndexSession | null = seed?.indexSession ?? null
  let acceptedBuildId = seed?.buildId ?? null

  return {
    update(options = {}) {
      const outputDir = resolveMadarOutputDirectory(root)
      const release = acquireIndexLease(outputDir)
      try {
        options.onProgress?.({ step: 'detect', message: 'Scanning files...' })
        const catalog = buildSourceCatalog(root, options)
        const accepted = loadAcceptedIndex(join(outputDir, 'graph.json'))
        if (acceptedBuildId !== null && accepted?.state.build_id !== acceptedBuildId) canonical = null
        acceptedBuildId = accepted?.state.build_id ?? null
        const unchanged = accepted !== null
          && accepted.state.policy.fingerprint === catalog.policy.fingerprint
          && accepted.state.source_root.kind === catalog.sourceRoot.kind
          && accepted.state.source_root.scope === catalog.sourceRoot.scope
          && sourceSnapshotsEqual(accepted.state.sources, catalog.snapshot)
        if (unchanged && accepted) {
          if (!catalogStillCurrent(catalog, options)) {
            throw new SourceChangedDuringBuildError()
          }
          const receipt: UpdateReceipt = {
            mode: canonical ? 'warm_incremental' : 'cold_noop',
            scanned_files: catalog.scannedFiles,
            parsed_files: 0,
            reused_files: catalog.snapshot.supported.length,
            invalidated_files: 0,
            dependency_closure_size: 0,
            fallback_reason: null,
            previous_build_id: accepted.state.build_id,
            accepted_build_id: accepted.state.build_id,
            publication_advanced: false,
          }
          return acceptedResult(root, accepted, receipt)
        }

        const coldReconcile = (
          fallbackReason: 'cold_process' | 'corrupt_warm_state',
          previousBuildId: string | null,
        ): GenerateIndexResult => {
          const nextSession = createCanonicalTypeScriptIndexSession({ root, files: catalog.supportedFiles })
          const result = buildAndPublishIndex({
            catalog,
            canonical: nextSession.result(),
            mode: 'update',
            options,
            updateReceipt: {
              mode: 'cold_reconcile',
              scanned_files: catalog.scannedFiles,
              parsed_files: catalog.snapshot.supported.length,
              reused_files: 0,
              invalidated_files: catalog.snapshot.supported.length,
              dependency_closure_size: catalog.snapshot.supported.length,
              fallback_reason: fallbackReason,
              previous_build_id: previousBuildId,
            },
            verifyCurrent: () => catalogStillCurrent(catalog, options),
          })
          canonical = nextSession
          acceptedBuildId = result.buildId
          return { ...result, indexSession: canonical }
        }

        if (!canonical || !accepted) {
          return coldReconcile('cold_process', accepted?.state.build_id ?? null)
        }

        const changed = changedSupportedFiles(accepted.state.sources, catalog.snapshot)
        const forceFull = controlsChanged(accepted.state.sources, catalog.snapshot)
          || accepted.state.policy.fingerprint !== catalog.policy.fingerprint
        let staged: ReturnType<CanonicalTypeScriptIndexSession['stageUpdate']>
        try {
          staged = canonical.stageUpdate({ files: catalog.supportedFiles, changedFiles: changed, forceFull })
        } catch {
          return coldReconcile('corrupt_warm_state', accepted.state.build_id)
        }
        const result = buildAndPublishIndex({
          catalog,
          canonical: staged.result,
          mode: 'update',
          options,
          updateReceipt: {
            mode: 'warm_incremental',
            scanned_files: catalog.scannedFiles,
            parsed_files: staged.metrics.parsedFiles,
            reused_files: staged.metrics.reusedFiles,
            invalidated_files: staged.metrics.invalidatedFiles,
            dependency_closure_size: staged.metrics.dependencyClosureSize,
            fallback_reason: forceFull ? 'compiler_control_changed' : null,
            previous_build_id: accepted.state.build_id,
          },
          verifyCurrent: () => catalogStillCurrent(catalog, options),
        })
        staged.commit()
        acceptedBuildId = result.buildId
        return { ...result, indexSession: canonical }
      } finally { release() }
    },
  }
}

/** One-shot updates are cold by definition; long-lived callers retain a session. */
export function updateIndex(rootPath = '.', options: UpdateIndexOptions = {}): GenerateIndexResult {
  return createUpdateIndexSession(rootPath).update(options)
}
