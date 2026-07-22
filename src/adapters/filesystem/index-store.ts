import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { loadGraphArtifact, writeGraphArtifact } from './graph-artifact.js'
import {
  IndexLeaseContentionError,
  readBuildState,
  type IndexBuildState,
  type IndexDiagnosticReceipt,
  type IndexingOutcome,
  type IndexingSummary,
} from '../../domain/index/build-state.js'
import type { KnowledgeGraph } from '../../domain/graph/directed-multigraph.js'
import { writeTextFileAtomically } from '../../shared/atomic-file.js'

export const INDEX_DIAGNOSTICS_VERSION = 1 as const
const LOCK_STALE_MS = 5 * 60_000
const RETIRED_OUTPUTS = [
  'manifest.json', 'watcher-state.json', 'indexing-manifest.failed.json',
  'indexing-manifest.failed.share-safe.json', 'cache', 'docs', 'wiki', 'graph.html',
  'graph-pages', 'graph.svg', 'graph.graphml', 'cypher.txt', 'obsidian',
] as const
export interface IndexDiagnostics {
  version: typeof INDEX_DIAGNOSTICS_VERSION
  build_id: string
  generated_at: string
  summary: IndexingSummary
  outcomes: IndexingOutcome[]
  index_diagnostics: IndexDiagnosticReceipt[]
}
export type PublicationStep =
  | 'before_report' | 'after_report'
  | 'before_diagnostics' | 'after_diagnostics'
  | 'before_graph_commit' | 'after_graph_commit'
  | 'before_cleanup' | 'after_cleanup'
export interface IndexStoreDependencies {
  writeText(path: string, contents: string): void
  writeGraph(graph: KnowledgeGraph, path: string): void
  remove(path: string): void
  hook?(step: PublicationStep): void
}
export interface IndexPublicationResult {
  graphPath: string
  reportPath: string
  diagnosticsPath: string
  diagnosticWarnings: string[]
}
const DEFAULT_DEPENDENCIES: IndexStoreDependencies = {
  writeText: writeTextFileAtomically,
  writeGraph: writeGraphArtifact,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function shareSafeDiagnostics(value: IndexDiagnostics) {
  const levels = { info: 0, warn: 0, error: 0 }
  for (const diagnostic of value.index_diagnostics) levels[diagnostic.level] += 1
  return {
    version: value.version,
    build_id: value.build_id,
    generated_at: value.generated_at,
    summary: value.summary,
    index_diagnostics: { total: value.index_diagnostics.length, levels },
  }
}
function attemptDerivedWrite(
  warnings: string[],
  label: string,
  before: PublicationStep,
  after: PublicationStep,
  action: () => void,
  dependencies: IndexStoreDependencies,
): void {
  try {
    dependencies.hook?.(before)
    action()
    dependencies.hook?.(after)
  } catch (error) {
    warnings.push(`${label} unavailable: ${message(error)}`)
  }
}
/** Publish derived diagnostics first and commit the authoritative graph last. */
export function publishAcceptedIndex(input: {
  graph: KnowledgeGraph
  outputDir: string
  report: string
  diagnostics: IndexDiagnostics
  dependencies?: Partial<IndexStoreDependencies>
}): IndexPublicationResult {
  const state = readBuildState(input.graph)
  if (!state || state.build_id !== input.diagnostics.build_id) {
    throw new Error('Refusing to publish an unauthenticated or mismatched index build')
  }
  const outputDir = resolve(input.outputDir)
  const graphPath = join(outputDir, 'graph.json')
  const reportPath = join(outputDir, 'GRAPH_REPORT.md')
  const diagnosticsPath = join(outputDir, 'indexing-manifest.json')
  const shareSafeDiagnosticsPath = join(outputDir, 'indexing-manifest.share-safe.json')
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies }
  const warnings: string[] = []
  mkdirSync(outputDir, { recursive: true })

  attemptDerivedWrite(warnings, 'graph report', 'before_report', 'after_report', () => {
    dependencies.writeText(reportPath, `${input.report.replace(/\n*$/, '')}\n`)
  }, dependencies)
  attemptDerivedWrite(warnings, 'index diagnostics', 'before_diagnostics', 'after_diagnostics', () => {
    dependencies.writeText(diagnosticsPath, `${JSON.stringify(input.diagnostics, null, 2)}\n`)
    dependencies.writeText(shareSafeDiagnosticsPath, `${JSON.stringify(shareSafeDiagnostics(input.diagnostics), null, 2)}\n`)
  }, dependencies)

  dependencies.hook?.('before_graph_commit')
  dependencies.writeGraph(input.graph, graphPath)
  try { dependencies.hook?.('after_graph_commit') } catch (error) {
    warnings.push(`post-commit hook failed after graph publication: ${message(error)}`)
  }

  attemptDerivedWrite(warnings, 'retired output cleanup', 'before_cleanup', 'after_cleanup', () => {
    for (const name of RETIRED_OUTPUTS) dependencies.remove(join(outputDir, name))
  }, dependencies)

  return {
    graphPath,
    reportPath,
    diagnosticsPath,
    diagnosticWarnings: warnings,
  }
}

export function loadAcceptedIndex(graphPath: string): { graph: KnowledgeGraph; state: IndexBuildState } | null {
  if (!existsSync(graphPath)) return null
  try {
    const graph = loadGraphArtifact(graphPath)
    const state = readBuildState(graph)
    return state ? { graph, state } : null
  } catch { return null }
}

export function readMatchingDiagnostics(graphPath: string): IndexDiagnostics | null {
  const accepted = loadAcceptedIndex(graphPath)
  if (!accepted) return null
  try {
    const value = JSON.parse(readFileSync(join(dirname(graphPath), 'indexing-manifest.json'), 'utf8')) as IndexDiagnostics
    return value?.version === INDEX_DIAGNOSTICS_VERSION && value.build_id === accepted.state.build_id ? value : null
  } catch { return null }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function clearStaleLock(lockPath: string): void {
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }
    const old = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
    if (old && (typeof record.pid !== 'number' || !processAlive(record.pid))) unlinkSync(lockPath)
  } catch { /* the subsequent exclusive open is authoritative */ }
}

/** Minimal cross-process exclusion. Long-lived controllers serialize retries in memory. */
export function acquireIndexLease(outputDir: string): () => void {
  const directory = resolve(outputDir)
  mkdirSync(directory, { recursive: true })
  const lockPath = join(directory, '.madar-build.lock')
  clearStaleLock(lockPath)
  const nonce = randomUUID()
  let descriptor: number
  try { descriptor = openSync(lockPath, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new IndexLeaseContentionError(directory)
    }
    throw error
  }
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce, acquired_at: new Date().toISOString() }), 'utf8')
  closeSync(descriptor)
  return () => {
    try {
      const record = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce?: unknown }
      if (record.nonce === nonce) unlinkSync(lockPath)
    } catch { /* ownership changed or lock already removed */ }
  }
}
