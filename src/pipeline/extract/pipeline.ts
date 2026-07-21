import { resolve } from 'node:path'

import type { IndexingDiagnostic } from '../../contracts/indexing.js'
import type { ExtractionData, ExtractionNode } from './contracts.js'
import type {
  PipelineStageDiagnostic,
  PipelineStageObserver,
} from '../../core/pipeline/stage.js'
import { resolveSourceNodeReferences } from './combine.js'
import {
  resolveCrossFilePythonImports,
  resolveCrossFileRelativeJsImports,
  resolveJsxRendersProxies,
  resolvePythonDjangoSemantics,
  resolvePythonFastApiSemantics,
} from './cross-file.js'
import type { ExtractionFileOutcome } from './dispatch.js'
import { resolveGoSemantics } from './go-cross-file.js'

export type ExtractionPipelineStage =
  | 'discovery_outcome'
  | 'capability_selection'
  | 'per_language_extraction'
  | 'framework_augmentation'
  | 'fragment_merge'
  | 'cross_file_relationships'
  | 'diagnostics_projection'

export type ExtractionStageDiagnostic = PipelineStageDiagnostic<ExtractionPipelineStage>
export type ExtractionStageObserver = PipelineStageObserver<ExtractionPipelineStage>

export interface ExtractionFileDiagnostic {
  filePath: string
  status: ExtractionFileOutcome['status']
  reason: ExtractionFileOutcome['reason']
  capability: string | null
  diagnostic: IndexingDiagnostic
}

export interface ExtractionPipelineResult {
  data: ExtractionData
  fileOutcomes: ExtractionFileOutcome[]
  diagnostics: ExtractionFileDiagnostic[]
}

export interface ExtractionDiscoveryInput {
  files: readonly string[]
  allowedTargets?: Iterable<string>
  contextNodes?: readonly ExtractionNode[]
}

export interface ExtractionDiscoveryPlan {
  files: string[]
  stemContextFiles: string[]
  allowedTargets: ReadonlySet<string>
}

/** Normalize the already-discovered file set before any capability is selected. */
export const buildExtractionDiscoveryPlan = (
  input: ExtractionDiscoveryInput,
): ExtractionDiscoveryPlan => {
  const files = [...input.files]
  const explicitTargets = input.allowedTargets ? [...input.allowedTargets] : undefined
  const requestedTargets = explicitTargets ?? files
  return {
    files,
    stemContextFiles: [
      ...files,
      ...(explicitTargets ?? []),
      ...(input.contextNodes?.map((node) => node.source_file).filter(Boolean) ?? []),
    ],
    allowedTargets: new Set(requestedTargets.map((filePath) => resolve(filePath))),
  }
}

export interface CrossFileResolutionInput {
  files: readonly string[]
  data: ExtractionData
  contextNodes?: ExtractionNode[]
}

/** Resolve corpus-wide relationships after all per-file fragments have been merged. */
export const resolveCrossFileExtraction = (input: CrossFileResolutionInput): ExtractionData => {
  const files = [...input.files]
  const contextOptions = input.contextNodes ? { contextNodes: input.contextNodes } : undefined
  let combined = contextOptions
    ? resolveCrossFilePythonImports(files, input.data, contextOptions)
    : resolveCrossFilePythonImports(files, input.data)

  combined = contextOptions
    ? resolvePythonFastApiSemantics(files, combined, contextOptions)
    : resolvePythonFastApiSemantics(files, combined)
  combined = contextOptions
    ? resolvePythonDjangoSemantics(files, combined, contextOptions)
    : resolvePythonDjangoSemantics(files, combined)
  combined = contextOptions
    ? resolveCrossFileRelativeJsImports(files, combined, contextOptions)
    : resolveCrossFileRelativeJsImports(files, combined)
  combined = contextOptions
    ? resolveGoSemantics(files, combined, contextOptions)
    : resolveGoSemantics(files, combined)
  combined = resolveJsxRendersProxies(combined)
  return contextOptions
    ? resolveSourceNodeReferences(combined, contextOptions)
    : resolveSourceNodeReferences(combined)
}

/** Project local parser diagnostics without hiding their owning file outcome. */
export const projectExtractionDiagnostics = (
  outcomes: readonly ExtractionFileOutcome[],
): ExtractionFileDiagnostic[] => outcomes.flatMap((outcome) => (
  outcome.diagnostics ?? []
).map((diagnostic) => ({
  filePath: outcome.filePath,
  status: outcome.status,
  reason: outcome.reason,
  capability: outcome.capability,
  diagnostic,
})))
