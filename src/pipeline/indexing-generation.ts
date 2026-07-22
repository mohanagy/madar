import { extname, resolve } from 'node:path'

import type { CanonicalTypeScriptIndexResult } from '../adapters/typescript/index.js'
import type {
  IndexDiagnosticReceipt,
  IndexingDiagnostic,
  IndexingOutcome,
} from '../contracts/indexing.js'
import { localIndexingPath } from './indexing-outcomes.js'

function canonicalTypeScriptCapability(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.js': return 'builtin:index:javascript'
    case '.jsx': return 'builtin:index:jsx'
    case '.tsx': return 'builtin:index:tsx'
    default: return 'builtin:index:typescript'
  }
}

function normalizeLocalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function canonicalDiagnosticsByFile(result: CanonicalTypeScriptIndexResult): {
  byFileId: Map<string, IndexingDiagnostic[]>
  projected: IndexDiagnosticReceipt[]
} {
  const filePathById = new Map(result.files.map((file) => [file.id, normalizeLocalPath(file.path)]))
  const byFileId = new Map<string, IndexingDiagnostic[]>()
  const globalDiagnostics: IndexingDiagnostic[] = []
  const projected = result.diagnostics.map((diagnostic): IndexDiagnosticReceipt => {
    const fileId = diagnostic.evidence?.file_id
    const filePath = fileId ? filePathById.get(fileId) : undefined
    const level = diagnostic.level === 'warn' ? 'warning' : diagnostic.level
    if (fileId && filePath && diagnostic.level !== 'info') {
      byFileId.set(fileId, [...(byFileId.get(fileId) ?? []), {
        code: diagnostic.id,
        level,
        message: diagnostic.message,
      }])
    } else if (diagnostic.level !== 'info') {
      globalDiagnostics.push({ code: diagnostic.id, level, message: diagnostic.message })
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
      byFileId.set(file.id, [...(byFileId.get(file.id) ?? []), ...globalDiagnostics])
    }
  }
  return { byFileId, projected }
}

export function canonicalTypeScriptIndexingOutcomes(input: {
  rootPath: string
  codeFiles: readonly string[]
  result: CanonicalTypeScriptIndexResult
}): { outcomes: IndexingOutcome[]; diagnostics: IndexDiagnosticReceipt[] } {
  const { byFileId, projected } = canonicalDiagnosticsByFile(input.result)
  const indexedFileByAbsolutePath = new Map(
    input.result.files.map((file) => [resolve(input.rootPath, file.path), file]),
  )
  const outcomes = input.codeFiles.map((filePath): IndexingOutcome => {
    const absolutePath = resolve(filePath)
    const localPath = localIndexingPath(input.rootPath, absolutePath)
    const indexedFile = indexedFileByAbsolutePath.get(absolutePath)
    if (!indexedFile) {
      return {
        path: localPath,
        kind: 'file',
        status: 'failed',
        reason: 'canonical_file_missing',
        capability: canonicalTypeScriptCapability(filePath),
      }
    }

    const diagnostics = byFileId.get(indexedFile.id) ?? []
    const hasError = diagnostics.some((diagnostic) => diagnostic.level === 'error')
    return {
      path: localPath,
      kind: 'file',
      status: hasError ? 'failed' : diagnostics.length > 0 ? 'indexed_with_warnings' : 'indexed',
      reason: diagnostics.length > 0 ? 'canonical_diagnostic' : 'indexed',
      capability: canonicalTypeScriptCapability(filePath),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    }
  })
  return { outcomes, diagnostics: projected }
}
