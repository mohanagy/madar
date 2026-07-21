import { extname, resolve } from 'node:path'

import type {
  ExtractionFallbackReason,
  ExtractionStrategy,
  IndexingDiagnostic,
  IndexingManifestV1,
  IndexingOutcome,
  IndexingSpiDiagnostic,
} from '../contracts/indexing.js'
import { builtinCapabilityRegistry } from '../infrastructure/capabilities.js'
import type { CanonicalTypeScriptIndexResult } from '../adapters/typescript/index.js'
import { isCanonicalTypeScriptSourceFile } from '../adapters/typescript/index.js'
import type { ExtractionFileOutcome } from './extract/dispatch.js'
import { classifyFile } from './detect.js'
import { localIndexingPath } from './indexing-outcomes.js'

function canonicalTypeScriptCapability(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.js': return 'canonical:javascript'
    case '.jsx': return 'canonical:jsx'
    case '.tsx': return 'canonical:tsx'
    default: return 'canonical:typescript'
  }
}

function normalizeLocalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

export function localExtractionIndexingOutcome(
  rootPath: string,
  outcome: ExtractionFileOutcome,
  receipt: {
    extractionStrategy?: ExtractionStrategy
    fallbackReason?: ExtractionFallbackReason
  } = {},
): IndexingOutcome {
  return {
    path: localIndexingPath(rootPath, outcome.filePath),
    kind: 'file',
    status: outcome.status,
    reason: outcome.reason,
    capability: outcome.capability,
    ...(receipt.extractionStrategy ? { extraction_strategy: receipt.extractionStrategy } : {}),
    ...(receipt.fallbackReason ? { fallback_reason: receipt.fallbackReason } : {}),
    ...(outcome.diagnostics?.length ? { diagnostics: outcome.diagnostics } : {}),
  }
}

function canonicalDiagnosticsByFile(result: CanonicalTypeScriptIndexResult): {
  byFileId: Map<string, IndexingDiagnostic[]>
  projected: IndexingSpiDiagnostic[]
} {
  const filePathById = new Map(result.files.map((file) => [file.id, normalizeLocalPath(file.path)]))
  const byFileId = new Map<string, IndexingDiagnostic[]>()
  const globalDiagnostics: IndexingDiagnostic[] = []
  const projected = result.diagnostics.map((diagnostic): IndexingSpiDiagnostic => {
    const fileId = diagnostic.evidence?.file_id
    const filePath = fileId ? filePathById.get(fileId) : undefined
    const level = diagnostic.level === 'warn' ? 'warning' : diagnostic.level
    if (fileId && filePath && diagnostic.level !== 'info') {
      const existing = byFileId.get(fileId) ?? []
      byFileId.set(fileId, [...existing, {
        code: diagnostic.id,
        level,
        message: diagnostic.message,
      }])
    } else if (diagnostic.level !== 'info') {
      globalDiagnostics.push({
        code: diagnostic.id,
        level,
        message: diagnostic.message,
      })
    }
    return {
      id: diagnostic.id,
      level: diagnostic.level,
      reason: 'canonical_diagnostic',
      ...(filePath ? { path: filePath } : {}),
      message: diagnostic.message,
    }
  })
  if (globalDiagnostics.length > 0) {
    for (const file of result.files) {
      const existing = byFileId.get(file.id) ?? []
      byFileId.set(file.id, [...existing, ...globalDiagnostics])
    }
  }
  return { byFileId, projected }
}

export function canonicalTypeScriptIndexingOutcomes(input: {
  rootPath: string
  codeFiles: readonly string[]
  result: CanonicalTypeScriptIndexResult
}): { outcomes: IndexingOutcome[]; diagnostics: IndexingSpiDiagnostic[] } {
  const { byFileId, projected } = canonicalDiagnosticsByFile(input.result)
  const indexedFileByAbsolutePath = new Map(
    input.result.files.map((file) => [resolve(input.rootPath, file.path), file]),
  )
  const outcomes = input.codeFiles.map((filePath): IndexingOutcome => {
    const absolutePath = resolve(filePath)
    const localPath = localIndexingPath(input.rootPath, absolutePath)
    const indexedFile = indexedFileByAbsolutePath.get(absolutePath)
    if (!indexedFile) {
      return isCanonicalTypeScriptSourceFile(filePath)
        ? {
            path: localPath,
            kind: 'file',
            status: 'failed',
            reason: 'canonical_file_missing',
            capability: canonicalTypeScriptCapability(filePath),
            extraction_strategy: 'canonical',
          }
        : {
            path: localPath,
            kind: 'file',
            status: 'unsupported',
            reason: 'unsupported_canonical_language',
            capability: null,
            extraction_strategy: 'canonical',
          }
    }

    const diagnostics = byFileId.get(indexedFile.id) ?? []
    const hasError = diagnostics.some((diagnostic) => diagnostic.level === 'error')
    return {
      path: localPath,
      kind: 'file',
      status: hasError ? 'failed' : diagnostics.length > 0 ? 'indexed_with_warnings' : 'indexed',
      reason: diagnostics.length > 0
        ? 'canonical_diagnostic'
        : 'indexed',
      capability: `canonical:${indexedFile.language}`,
      extraction_strategy: 'canonical',
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    }
  })
  return { outcomes, diagnostics: projected }
}

export function retainedIndexingOutcomes(input: {
  rootPath: string
  files: readonly string[]
  previousManifest: IndexingManifestV1 | null
  retainedSourceFiles?: ReadonlySet<string>
}): IndexingOutcome[] {
  const previousByPath = new Map(input.previousManifest?.outcomes.map((outcome) => [outcome.path, outcome]) ?? [])
  return input.files.map((filePath): IndexingOutcome => {
    const localPath = localIndexingPath(input.rootPath, filePath)
    const previous = previousByPath.get(localPath)
    const expectedGraphEvidence = previous === undefined
      || previous.status === 'indexed'
      || previous.status === 'indexed_with_warnings'
    if (
      expectedGraphEvidence
      && input.retainedSourceFiles
      && !input.retainedSourceFiles.has(resolve(filePath))
    ) {
      return {
        path: localPath,
        kind: 'file',
        status: 'failed',
        reason: 'retained_evidence_missing',
        capability: previous?.capability ?? null,
      }
    }
    if (previous) {
      return previous
    }
    const fileType = classifyFile(filePath)
    const capability = builtinCapabilityRegistry.resolveExtractorForPath(filePath, fileType)
    return {
      path: localPath,
      kind: 'file',
      status: 'indexed',
      reason: 'retained_from_graph',
      capability: capability?.id ?? null,
    }
  })
}
