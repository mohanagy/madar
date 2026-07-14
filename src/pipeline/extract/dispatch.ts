import type { IndexingDiagnostic, IndexingOutcomeStatus, IndexingReasonCode } from '../../contracts/indexing.js'
import type { ExtractionEdge, ExtractionNode } from '../../contracts/types.js'
import { builtinCapabilityRegistry, type CapabilityRegistry } from '../../infrastructure/capabilities.js'
import { classifyFile, type FileTypeValue } from '../detect.js'

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

export type ExtractorHandler = (filePath: string, allowedTargets: ReadonlySet<string>) => ExtractionFragment

export type ExtractorHandlerMap = Readonly<Record<string, ExtractorHandler>>

export interface SingleFileExtractionDependencies {
  registry?: CapabilityRegistry
  readCached?: (filePath: string) => ExtractionFragment | null | undefined
  writeCached?: (filePath: string, extraction: ExtractionFragment) => void
  classifySourceFile?: (filePath: string) => FileTypeValue | null
  onOutcome?: (outcome: ExtractionFileOutcome) => void
  recoverFailures?: boolean
}

function emptyExtractionFragment(): ExtractionFragment {
  return { nodes: [], edges: [] }
}

export function dispatchSingleFileExtraction(
  filePath: string,
  allowedTargets: ReadonlySet<string>,
  handlers: ExtractorHandlerMap,
  dependencies: SingleFileExtractionDependencies = {},
): ExtractionFragment {
  const registry = dependencies.registry ?? builtinCapabilityRegistry
  const sourceFileType = dependencies.classifySourceFile?.(filePath) ?? classifyFile(filePath)
  const capability = registry.resolveExtractorForPath(filePath, sourceFileType)
  const cached = dependencies.readCached?.(filePath) ?? null
  if (cached) {
    const diagnostics = cached.diagnostics
    const empty = cached.nodes.length === 0 && cached.edges.length === 0
    dependencies.onOutcome?.({
      filePath,
      status: empty ? 'failed' : (diagnostics?.length ?? 0) > 0 ? 'indexed_with_warnings' : 'indexed',
      reason: empty ? 'empty_extraction' : diagnostics?.length ? 'parser_fallback' : 'indexed_from_cache',
      capability: capability?.id ?? null,
      ...(diagnostics?.length ? { diagnostics } : {}),
    })
    return cached
  }

  if (!capability) {
    dependencies.onOutcome?.({
      filePath,
      status: 'unsupported',
      reason: 'capability_missing',
      capability: null,
    })
    return emptyExtractionFragment()
  }

  const handler = handlers[capability.id]
  if (!handler) {
    const error = new Error(`No extractor handler registered for capability '${capability.id}'`)
    if (!dependencies.recoverFailures) {
      throw error
    }
    dependencies.onOutcome?.({
      filePath,
      status: 'failed',
      reason: 'extractor_error',
      capability: capability.id,
      diagnostics: [{ code: 'missing_extractor_handler', level: 'error', message: error.message }],
    })
    return emptyExtractionFragment()
  }

  let extraction: ExtractionFragment
  try {
    extraction = handler(filePath, allowedTargets)
  } catch (error) {
    if (!dependencies.recoverFailures) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    dependencies.onOutcome?.({
      filePath,
      status: 'failed',
      reason: 'extractor_error',
      capability: capability.id,
      diagnostics: [{ code: 'extractor_error', level: 'error', message }],
    })
    return emptyExtractionFragment()
  }
  dependencies.writeCached?.(filePath, extraction)
  const diagnostics = extraction.diagnostics
  const empty = extraction.nodes.length === 0 && extraction.edges.length === 0
  dependencies.onOutcome?.({
    filePath,
    status: empty ? 'failed' : (diagnostics?.length ?? 0) > 0 ? 'indexed_with_warnings' : 'indexed',
    reason: empty ? 'empty_extraction' : diagnostics?.length ? 'parser_fallback' : 'indexed',
    capability: capability.id,
    ...(diagnostics?.length ? { diagnostics } : {}),
  })
  return extraction
}
