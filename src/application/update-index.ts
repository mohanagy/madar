import { join, resolve } from 'node:path'

import {
  buildSourceCatalog, sourceCatalogStillCurrent, sourceRootIdentitiesEqual, type SourceCatalogOptions,
} from '../adapters/filesystem/source-catalog.js'
import {
  acceptedIndexArtifactsComplete, acquireIndexLease, loadAcceptedIndex,
} from '../adapters/filesystem/index-store.js'
import {
  buildAndPublishIndex, indexResultFromState, SourceChangedDuringBuildError,
  type GenerateIndexOptions, type GenerateIndexResult,
} from './generate-index.js'
import { sourceSnapshotsEqual, type IndexBuildState } from '../domain/index/build-state.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'
export type UpdateIndexOptions = Omit<GenerateIndexOptions, 'clusterOnly'> & { leaseOwnerToken?: string }
function catalogOptions(options: UpdateIndexOptions, state: IndexBuildState | null): SourceCatalogOptions {
  const strict = state?.policy.settings.indexing_strict
  const indexingStrict = options.indexingStrict ?? (strict ? { maxFailed: strict.max_failed, maxUnsupported: strict.max_unsupported } : undefined)
  return {
    followSymlinks: options.followSymlinks ?? state?.policy.settings.follow_symlinks ?? false,
    respectGitignore: options.respectGitignore ?? state?.policy.settings.respect_gitignore ?? false,
    ...(indexingStrict ? { indexingStrict } : {}),
  }
}

export function updateIndex(rootPath = '.', options: UpdateIndexOptions = {}): GenerateIndexResult {
  const root = resolve(rootPath)
  const outputDir = resolveMadarOutputDirectory(root)
  const release = acquireIndexLease(outputDir, {}, options.leaseOwnerToken)
  try {
    options.onProgress?.({ step: 'detect', message: 'Scanning files...' })
    const accepted = loadAcceptedIndex(join(outputDir, 'graph.json'))
    const effectiveCatalogOptions = catalogOptions(options, accepted?.state ?? null)
    const catalog = buildSourceCatalog(root, effectiveCatalogOptions)
    const sourceUnchanged = accepted !== null
      && accepted.state.policy.fingerprint === catalog.policy.fingerprint
      && sourceRootIdentitiesEqual(accepted.state.source_root, catalog.sourceRoot)
      && sourceSnapshotsEqual(accepted.state.sources, catalog.snapshot)
    if (sourceUnchanged && accepted && acceptedIndexArtifactsComplete(join(outputDir, 'graph.json'))) {
      if (!sourceCatalogStillCurrent(catalog, effectiveCatalogOptions)) throw new SourceChangedDuringBuildError()
      return indexResultFromState({
        mode: 'update', rootPath: root, graph: accepted.graph, state: accepted.state,
        notes: ['Source snapshot is unchanged; parsing, analysis, and publication were skipped.'],
        updateReceipt: {
          mode: 'cold_noop', scanned_files: catalog.scannedFiles, parsed_files: 0,
          reused_files: catalog.snapshot.supported.length, invalidated_files: 0, dependency_closure_size: 0,
          fallback_reason: null, previous_build_id: accepted.state.build_id, accepted_build_id: accepted.state.build_id,
          publication_advanced: false,
        },
      })
    }
    const supportedFiles = catalog.snapshot.supported.length
    return buildAndPublishIndex({
      catalog,
      mode: 'update',
      options: { ...options, ...effectiveCatalogOptions },
      updateReceipt: {
        mode: 'cold_reconcile', scanned_files: catalog.scannedFiles, parsed_files: supportedFiles,
        reused_files: 0, invalidated_files: supportedFiles, dependency_closure_size: supportedFiles,
        fallback_reason: accepted ? sourceUnchanged ? 'accepted_artifact_incomplete' : 'source_or_policy_changed' : 'cold_process',
        previous_build_id: accepted?.state.build_id ?? null,
      },
      verifyCurrent: () => sourceCatalogStillCurrent(catalog, effectiveCatalogOptions),
    })
  } finally { release() }
}
