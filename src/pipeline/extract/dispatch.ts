import type { IndexingDiagnostic, IndexingOutcomeStatus, IndexingReasonCode } from '../../contracts/indexing.js'
import type { ExtractionEdge, ExtractionNode } from './contracts.js'
import { reportSkippedPipelineStage, runPipelineStage } from '../../core/pipeline/stage.js'
import { builtinCapabilityRegistry, type CapabilityRegistry } from '../../infrastructure/capabilities.js'
import { classifyFile, type FileTypeValue } from '../detect.js'
import type { ExtractionStageObserver } from './pipeline.js'

export interface ExtractionFragment {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
  diagnostics?: IndexingDiagnostic[]
}

export interface ExtractionFileOutcome {
  filePath: string
  status: Extract<IndexingOutcomeStatus, 'indexed' | 'indexed_with_warnings' | 'unsupported' | 'failed'>
  reason: Extract<IndexingReasonCode, 'indexed' | 'indexed_from_cache' | 'parser_fallback' | 'empty_extraction' | 'capability_missing' | 'extractor_error'>
  capability: string | null
  diagnostics?: IndexingDiagnostic[]
}

export interface ExtractionDispatchResult {
  fragment: ExtractionFragment
  outcome: ExtractionFileOutcome
}

export interface ExtractionCapabilitySelection {
  sourceFileType: FileTypeValue | null
  capability: ReturnType<CapabilityRegistry['resolveExtractorForPath']>
}

export interface StagedExtractionFragment {
  fragment: ExtractionFragment
  augmentFramework: () => ExtractionFragment
}

export type ExtractorHandlerOutput = ExtractionFragment | StagedExtractionFragment

export type ExtractorHandler = (filePath: string, allowedTargets: ReadonlySet<string>) => ExtractionFragment

export type PipelineExtractorHandler = (
  filePath: string,
  allowedTargets: ReadonlySet<string>,
) => ExtractorHandlerOutput

export type ExtractorHandlerMap = Readonly<Record<string, ExtractorHandler>>
export type PipelineExtractorHandlerMap = Readonly<Record<string, PipelineExtractorHandler>>

export interface SingleFileExtractionDependencies {
  registry?: CapabilityRegistry
  readCached?: (filePath: string) => ExtractionFragment | null | undefined
  writeCached?: (filePath: string, extraction: ExtractionFragment) => void
  classifySourceFile?: (filePath: string) => FileTypeValue | null
  onOutcome?: (outcome: ExtractionFileOutcome) => void
  onStageDiagnostic?: ExtractionStageObserver
  recoverFailures?: boolean
}

const emptyExtractionFragment = (): ExtractionFragment => {
  return { nodes: [], edges: [] }
}

export const selectExtractionCapability = (
  filePath: string,
  dependencies: Pick<SingleFileExtractionDependencies, 'registry' | 'classifySourceFile'> = {},
): ExtractionCapabilitySelection => {
  const registry = dependencies.registry ?? builtinCapabilityRegistry
  const sourceFileType = dependencies.classifySourceFile?.(filePath) ?? classifyFile(filePath)
  return {
    sourceFileType,
    capability: registry.resolveExtractorForPath(filePath, sourceFileType),
  }
}

const finishDispatch = (
  fragment: ExtractionFragment,
  outcome: ExtractionFileOutcome,
  onOutcome?: (outcome: ExtractionFileOutcome) => void,
): ExtractionDispatchResult => {
  onOutcome?.(outcome)
  return { fragment, outcome }
}

const isStagedExtractionFragment = (
  output: ExtractorHandlerOutput,
): output is StagedExtractionFragment => 'fragment' in output && 'augmentFramework' in output

const baseFragment = (output: ExtractorHandlerOutput): ExtractionFragment => (
  isStagedExtractionFragment(output) ? output.fragment : output
)

const reportSkippedExtractionStage = (
  stage: 'per_language_extraction' | 'framework_augmentation',
  dependencies: SingleFileExtractionDependencies,
): void => reportSkippedPipelineStage({
  pipeline: 'extraction',
  stage,
  inputCount: 1,
  ...(dependencies.onStageDiagnostic ? { observer: dependencies.onStageDiagnostic } : {}),
})

export function dispatchSingleFileExtractionWithOutcome(
  filePath: string,
  allowedTargets: ReadonlySet<string>,
  handlers: PipelineExtractorHandlerMap,
  dependencies: SingleFileExtractionDependencies = {},
): ExtractionDispatchResult {
  const selection = runPipelineStage({
    pipeline: 'extraction',
    stage: 'capability_selection',
    inputCount: 1,
    outputCount: (output) => output.capability ? 1 : 0,
    ...(dependencies.onStageDiagnostic ? { observer: dependencies.onStageDiagnostic } : {}),
  }, () => selectExtractionCapability(filePath, dependencies))
  const capability = selection.capability
  const cached = dependencies.readCached?.(filePath) ?? null
  if (cached) {
    reportSkippedExtractionStage('per_language_extraction', dependencies)
    reportSkippedExtractionStage('framework_augmentation', dependencies)
    const diagnostics = cached.diagnostics
    const empty = cached.nodes.length === 0 && cached.edges.length === 0
    return finishDispatch(cached, {
      filePath,
      status: empty ? 'failed' : (diagnostics?.length ?? 0) > 0 ? 'indexed_with_warnings' : 'indexed',
      reason: empty ? 'empty_extraction' : diagnostics?.length ? 'parser_fallback' : 'indexed_from_cache',
      capability: capability?.id ?? null,
      ...(diagnostics?.length ? { diagnostics } : {}),
    }, dependencies.onOutcome)
  }

  if (!capability) {
    reportSkippedExtractionStage('per_language_extraction', dependencies)
    reportSkippedExtractionStage('framework_augmentation', dependencies)
    return finishDispatch(emptyExtractionFragment(), {
      filePath,
      status: 'unsupported',
      reason: 'capability_missing',
      capability: null,
    }, dependencies.onOutcome)
  }

  const handler = handlers[capability.id]
  const missingHandlerError = new Error(`No extractor handler registered for capability '${capability.id}'`)
  let extraction: ExtractionFragment
  let frameworkStageStarted = false
  try {
    const extracted = runPipelineStage({
      pipeline: 'extraction',
      stage: 'per_language_extraction',
      inputCount: 1,
      outputCount: (output) => {
        const fragment = baseFragment(output)
        return fragment.nodes.length + fragment.edges.length
      },
      warningCount: (output) => baseFragment(output).diagnostics?.length ?? 0,
      ...(dependencies.onStageDiagnostic ? { observer: dependencies.onStageDiagnostic } : {}),
    }, () => {
      if (!handler) {
        throw missingHandlerError
      }
      return handler(filePath, allowedTargets)
    })

    if (isStagedExtractionFragment(extracted)) {
      frameworkStageStarted = true
      extraction = runPipelineStage({
        pipeline: 'extraction',
        stage: 'framework_augmentation',
        inputCount: extracted.fragment.nodes.length + extracted.fragment.edges.length,
        outputCount: (output) => output.nodes.length + output.edges.length,
        warningCount: (output) => output.diagnostics?.length ?? 0,
        ...(dependencies.onStageDiagnostic ? { observer: dependencies.onStageDiagnostic } : {}),
      }, extracted.augmentFramework)
    } else {
      reportSkippedExtractionStage('framework_augmentation', dependencies)
      extraction = extracted
    }
  } catch (error) {
    if (!frameworkStageStarted) {
      reportSkippedExtractionStage('framework_augmentation', dependencies)
    }
    if (!dependencies.recoverFailures) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return finishDispatch(emptyExtractionFragment(), {
      filePath,
      status: 'failed',
      reason: 'extractor_error',
      capability: capability.id,
      diagnostics: [{
        code: error === missingHandlerError ? 'missing_extractor_handler' : 'extractor_error',
        level: 'error',
        message,
      }],
    }, dependencies.onOutcome)
  }

  dependencies.writeCached?.(filePath, extraction)
  const diagnostics = extraction.diagnostics
  const empty = extraction.nodes.length === 0 && extraction.edges.length === 0
  return finishDispatch(extraction, {
    filePath,
    status: empty ? 'failed' : (diagnostics?.length ?? 0) > 0 ? 'indexed_with_warnings' : 'indexed',
    reason: empty ? 'empty_extraction' : diagnostics?.length ? 'parser_fallback' : 'indexed',
    capability: capability.id,
    ...(diagnostics?.length ? { diagnostics } : {}),
  }, dependencies.onOutcome)
}

export function dispatchSingleFileExtraction(
  filePath: string,
  allowedTargets: ReadonlySet<string>,
  handlers: PipelineExtractorHandlerMap,
  dependencies: SingleFileExtractionDependencies = {},
): ExtractionFragment {
  return dispatchSingleFileExtractionWithOutcome(
    filePath,
    allowedTargets,
    handlers,
    dependencies,
  ).fragment
}
