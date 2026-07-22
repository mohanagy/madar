import { join, resolve } from 'node:path'

import { buildCanonicalTypeScriptIndex } from '../adapters/typescript/index.js'
import {
  buildSourceCatalog,
  sourceCatalogStillCurrent,
  type SourceCatalogOptions,
} from '../adapters/filesystem/source-catalog.js'
import { acquireIndexLease, loadAcceptedIndex } from '../adapters/filesystem/index-store.js'
import {
  buildAndPublishIndex,
  SourceChangedDuringBuildError,
  type GenerateIndexOptions,
  type GenerateIndexResult,
} from './generate-index.js'
import { sourceSnapshotsEqual, type IndexBuildState, type UpdateReceipt } from '../domain/index/build-state.js'
import { buildDiscoverySafetyMetadata, parseDiscoverySafetyMetadata } from '../shared/discovery-safety.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'

export type UpdateIndexOptions = Omit<GenerateIndexOptions, 'clusterOnly'>

function catalogOptions(options: UpdateIndexOptions, state: IndexBuildState | null): SourceCatalogOptions {
  const strict = state?.policy.settings.indexing_strict
  const followSymlinks = options.followSymlinks ?? state?.policy.settings.follow_symlinks
  const respectGitignore = options.respectGitignore ?? state?.policy.settings.respect_gitignore
  const indexingStrict = options.indexingStrict ?? (strict
    ? { maxFailed: strict.max_failed, maxUnsupported: strict.max_unsupported }
    : undefined)
  return {
    ...(followSymlinks === undefined ? {} : { followSymlinks }),
    ...(respectGitignore === undefined ? {} : { respectGitignore }),
    ...(indexingStrict === undefined ? {} : { indexingStrict }),
  }
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

/**
 * Scan once, skip an authenticated no-op, otherwise run the one canonical
 * full reconcile. No compiler, AST, fact, or dependency state survives calls.
 */
export function updateIndex(rootPath = '.', options: UpdateIndexOptions = {}): GenerateIndexResult {
  const root = resolve(rootPath)
  const outputDir = resolveMadarOutputDirectory(root)
  const release = acquireIndexLease(outputDir)
  try {
    options.onProgress?.({ step: 'detect', message: 'Scanning files...' })
    const accepted = loadAcceptedIndex(join(outputDir, 'graph.json'))
    const effectiveCatalogOptions = catalogOptions(options, accepted?.state ?? null)
    const catalog = buildSourceCatalog(root, effectiveCatalogOptions)
    const unchanged = accepted !== null
      && accepted.state.policy.fingerprint === catalog.policy.fingerprint
      && accepted.state.source_root.kind === catalog.sourceRoot.kind
      && accepted.state.source_root.scope === catalog.sourceRoot.scope
      && sourceSnapshotsEqual(accepted.state.sources, catalog.snapshot)

    if (unchanged && accepted) {
      if (!sourceCatalogStillCurrent(catalog, effectiveCatalogOptions)) throw new SourceChangedDuringBuildError()
      return acceptedResult(root, accepted, {
        mode: 'cold_noop',
        scanned_files: catalog.scannedFiles,
        parsed_files: 0,
        reused_files: catalog.snapshot.supported.length,
        invalidated_files: 0,
        dependency_closure_size: 0,
        fallback_reason: null,
        previous_build_id: accepted.state.build_id,
        accepted_build_id: accepted.state.build_id,
        publication_advanced: false,
      })
    }

    const supportedFiles = catalog.snapshot.supported.length
    const canonical = buildCanonicalTypeScriptIndex({ root, files: catalog.supportedFiles })
    return buildAndPublishIndex({
      catalog,
      canonical,
      mode: 'update',
      options: { ...options, ...effectiveCatalogOptions },
      updateReceipt: {
        mode: 'cold_reconcile',
        scanned_files: catalog.scannedFiles,
        parsed_files: supportedFiles,
        reused_files: 0,
        invalidated_files: supportedFiles,
        dependency_closure_size: supportedFiles,
        fallback_reason: accepted ? 'source_or_policy_changed' : 'cold_process',
        previous_build_id: accepted?.state.build_id ?? null,
      },
      verifyCurrent: () => sourceCatalogStillCurrent(catalog, effectiveCatalogOptions),
    })
  } finally {
    release()
  }
}
