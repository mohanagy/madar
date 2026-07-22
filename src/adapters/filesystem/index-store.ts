import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readBoundedUtf8, readGraphArtifactReceipt, writeGraphArtifact, type GraphArtifactReceipt } from './graph-artifact.js'
import {
  INDEXING_OUTCOME_STATUSES, INDEXING_REASON_CODES, IndexLeaseContentionError, readBuildState,
  type IndexBuildState, type IndexDiagnosticReceipt, type IndexingOutcome, type IndexingSummary,
} from '../../domain/index/build-state.js'
import { serializeGraphArtifact } from '../../domain/graph/artifact.js'
import type { KnowledgeGraph } from '../../domain/graph/directed-multigraph.js'
import { writeTextFileAtomically } from '../../shared/atomic-file.js'
import { hasOnlyKeys, isRecord } from '../../shared/guards.js'
import { validateGraphPath } from '../../shared/security.js'
export const INDEX_DIAGNOSTICS_VERSION = 1 as const
const REPORT_GRAPH_SHA256 = /^<!-- madar-graph-sha256: ([a-f0-9]{64}) -->$/m
const REPORT_BUILD_ID = /^<!-- madar-build-id: ([a-f0-9]{64}) -->$/m
const REPORT_AUTHENTICATION_HEADER = /^(?:<!-- madar-(?:graph-sha256|build-id): [a-f0-9]{64} -->\n)+/
const MAX_REPORT_BYTES = 5_000_000
const LOCK_STALE_MS = 5 * 60_000
const RETIRED_OUTPUTS = [
  'manifest.json', 'watcher-state.json', 'indexing-manifest.failed.json',
  'indexing-manifest.failed.share-safe.json', 'cache', 'docs', 'wiki', 'graph.html',
  'graph-pages', 'graph.svg', 'graph.graphml', 'cypher.txt', 'obsidian',
] as const
export interface IndexDiagnostics {
  version: typeof INDEX_DIAGNOSTICS_VERSION; build_id: string; graph_sha256: string; generated_at: string
  summary: IndexingSummary; outcomes: IndexingOutcome[]; index_diagnostics: IndexDiagnosticReceipt[]
}
export type PublicationStep =
  | 'before_report' | 'after_report' | 'before_diagnostics' | 'after_diagnostics'
  | 'before_graph_commit' | 'after_graph_commit' | 'before_cleanup' | 'after_cleanup'
export interface IndexStoreDependencies {
  writeText(path: string, contents: string): void; writeGraph(graph: KnowledgeGraph, path: string): void
  remove(path: string): void; hook?(step: PublicationStep): void
}
export type IndexDiagnosticsInput = Omit<IndexDiagnostics, 'graph_sha256'> & { graph_sha256?: string }
export interface IndexLeaseDependencies {
  open(path: string): number; write(descriptor: number, contents: string): void
  close(descriptor: number): void; unlink(path: string): void; hook?(step: 'stale_reclaim_claimed' | 'before_stale_unlink'): void
}
const DEFAULT_DEPENDENCIES: IndexStoreDependencies = {
  writeText: writeTextFileAtomically, writeGraph: writeGraphArtifact,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
}
const DEFAULT_LEASE_DEPENDENCIES: IndexLeaseDependencies = {
  open: (path) => openSync(path, 'wx', 0o600), write: (descriptor, contents) => writeFileSync(descriptor, contents, 'utf8'),
  close: closeSync, unlink: unlinkSync,
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function authenticatedReport(report: string, graphSha256: string, buildId: string | null): string {
  const body = report.replace(REPORT_AUTHENTICATION_HEADER, '').replace(/^\n+/, '').replace(/\n*$/, '')
  const headers = [`<!-- madar-graph-sha256: ${graphSha256} -->`, ...(buildId ? [`<!-- madar-build-id: ${buildId} -->`] : [])]
  return `${headers.join('\n')}\n${body}\n`
}
export function authenticateReportForGraph(report: string, graph: KnowledgeGraph): string {
  const artifact = serializeGraphArtifact(graph)
  return authenticatedReport(report, sha256(artifact), readBuildState(graph)?.build_id ?? null)
}
function shareSafeDiagnostics(value: IndexDiagnostics) {
  const levels = { info: 0, warn: 0, error: 0 }
  for (const diagnostic of value.index_diagnostics) levels[diagnostic.level] += 1
  return {
    version: value.version, build_id: value.build_id, graph_sha256: value.graph_sha256,
    generated_at: value.generated_at, summary: value.summary,
    index_diagnostics: { total: value.index_diagnostics.length, levels },
  }
}
function attemptDerivedWrite(warnings: string[], label: string, before: PublicationStep, after: PublicationStep,
  action: () => void, dependencies: IndexStoreDependencies): void {
  try {
    dependencies.hook?.(before)
    action()
    dependencies.hook?.(after)
  } catch (error) { warnings.push(`${label} unavailable: ${message(error)}`) }
}
export function publishAcceptedIndex(input: {
  graph: KnowledgeGraph; outputDir: string; report: string; diagnostics: IndexDiagnosticsInput
  assertCurrent?: () => void; dependencies?: Partial<IndexStoreDependencies>
}) {
  const state = readBuildState(input.graph)
  if (!state || state.build_id !== input.diagnostics.build_id) throw new Error('Refusing to publish an unauthenticated or mismatched index build')
  const outputDir = resolve(input.outputDir)
  const graphPath = join(outputDir, 'graph.json')
  const reportPath = join(outputDir, 'GRAPH_REPORT.md')
  const diagnosticsPath = join(outputDir, 'indexing-manifest.json')
  const shareSafeDiagnosticsPath = join(outputDir, 'indexing-manifest.share-safe.json')
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies }
  const warnings: string[] = []
  const graphSha256 = sha256(serializeGraphArtifact(input.graph))
  if (input.diagnostics.graph_sha256 && input.diagnostics.graph_sha256 !== graphSha256) throw new Error('Refusing to publish diagnostics for different graph bytes')
  const diagnostics: IndexDiagnostics = { ...input.diagnostics, graph_sha256: graphSha256 }
  mkdirSync(outputDir, { recursive: true })
  attemptDerivedWrite(warnings, 'graph report', 'before_report', 'after_report', () => {
    dependencies.writeText(reportPath, authenticatedReport(input.report, graphSha256, state.build_id))
  }, dependencies)
  attemptDerivedWrite(warnings, 'index diagnostics', 'before_diagnostics', 'after_diagnostics', () => {
    dependencies.writeText(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`)
    dependencies.writeText(shareSafeDiagnosticsPath, `${JSON.stringify(shareSafeDiagnostics(diagnostics), null, 2)}\n`)
  }, dependencies)
  dependencies.hook?.('before_graph_commit')
  input.assertCurrent?.()
  dependencies.writeGraph(input.graph, graphPath)
  try { dependencies.hook?.('after_graph_commit') } catch (error) { warnings.push(`post-commit hook failed after graph publication: ${message(error)}`) }
  attemptDerivedWrite(warnings, 'retired output cleanup', 'before_cleanup', 'after_cleanup', () => {
    for (const name of RETIRED_OUTPUTS) dependencies.remove(join(outputDir, name))
  }, dependencies)
  return { graphPath, reportPath, diagnosticsPath, diagnosticWarnings: warnings }
}
type GraphReceipt = { graph: KnowledgeGraph; state: IndexBuildState | null; graphSha256: string; graphModifiedMs: number }
type AcceptedIndex = GraphReceipt & { state: IndexBuildState }
type BoundArtifact = Pick<IndexDiagnostics, 'version' | 'build_id' | 'graph_sha256'>
type ArtifactParser<T extends BoundArtifact> = (value: unknown) => T | null
export type MatchingReportReceipt = {
  report: string; reportModifiedMs: number; graphSha256: string; graphModifiedMs: number; buildId: string | null
}
const SHA256 = /^[a-f0-9]{64}$/
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  return isRecord(value) && required.every((key) => Object.hasOwn(value, key))
    && hasOnlyKeys(value, [...required, ...optional]) ? value : null
}
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function validCounts(value: unknown, allowed?: readonly string[]): boolean {
  return isRecord(value) && Object.entries(value).every(([key, count]) => key.length > 0
    && (!allowed || allowed.includes(key)) && nonNegative(count))
}
function validSummary(value: unknown): value is IndexingSummary {
  const record = shape(value, ['state', 'candidates', 'counts', 'reason_buckets', 'capability_buckets'])
  const counts = shape(record?.counts, INDEXING_OUTCOME_STATUSES)
  return !!record && ['complete', 'partial', 'failed'].includes(String(record.state))
    && nonNegative(record.candidates) && !!counts && Object.values(counts).every(nonNegative)
    && validCounts(record.reason_buckets, INDEXING_REASON_CODES) && validCounts(record.capability_buckets)
    && Object.values(counts).reduce<number>((sum, count) => sum + Number(count), 0) === record.candidates
}
function validDiagnostic(value: unknown, receipt: boolean): boolean {
  const key = receipt ? 'id' : 'code'
  const record = shape(value, [key, 'level', ...(receipt ? ['reason'] : [])], ['path', 'message'])
  const levels = receipt ? ['info', 'warn', 'error'] : ['info', 'warning', 'error']
  return !!record && typeof record[key] === 'string' && record[key].length > 0
    && levels.includes(String(record.level)) && (!receipt || record.reason === 'canonical_diagnostic')
    && (record.path === undefined || typeof record.path === 'string')
    && (record.message === undefined || typeof record.message === 'string')
}
function validOutcome(value: unknown): boolean {
  const record = shape(value, ['path', 'kind', 'status', 'reason', 'capability'], ['diagnostics'])
  return !!record && typeof record.path === 'string' && record.path.length > 0
    && ['file', 'directory'].includes(String(record.kind))
    && INDEXING_OUTCOME_STATUSES.includes(record.status as IndexingOutcome['status'])
    && INDEXING_REASON_CODES.includes(record.reason as IndexingOutcome['reason'])
    && (record.capability === null || typeof record.capability === 'string')
    && (record.diagnostics === undefined || (Array.isArray(record.diagnostics)
      && record.diagnostics.every((entry) => validDiagnostic(entry, false))))
}
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function parseDiagnostics(value: unknown): IndexDiagnostics | null {
  const record = shape(value, ['version', 'build_id', 'graph_sha256', 'generated_at', 'summary', 'outcomes', 'index_diagnostics'])
  return record?.version === INDEX_DIAGNOSTICS_VERSION && SHA256.test(String(record.build_id))
    && SHA256.test(String(record.graph_sha256)) && validTimestamp(record.generated_at)
    && validSummary(record.summary) && Array.isArray(record.outcomes)
    && record.outcomes.length === record.summary.candidates && record.outcomes.every(validOutcome)
    && Array.isArray(record.index_diagnostics) && record.index_diagnostics.every((entry) => validDiagnostic(entry, true))
    ? record as unknown as IndexDiagnostics : null
}
function parseShareSafeDiagnostics(value: unknown): BoundArtifact | null {
  const record = shape(value, ['version', 'build_id', 'graph_sha256', 'generated_at', 'summary', 'index_diagnostics'])
  const diagnostics = shape(record?.index_diagnostics, ['total', 'levels'])
  const levels = shape(diagnostics?.levels, ['info', 'warn', 'error'])
  return record?.version === INDEX_DIAGNOSTICS_VERSION && SHA256.test(String(record.build_id))
    && SHA256.test(String(record.graph_sha256)) && validTimestamp(record.generated_at) && validSummary(record.summary)
    && !!diagnostics && nonNegative(diagnostics.total) && !!levels && Object.values(levels).every(nonNegative)
    && Object.values(levels).reduce<number>((sum, count) => sum + Number(count), 0) === diagnostics.total
    ? record as unknown as BoundArtifact : null
}

function loadGraphReceipt(graphPath: string, supplied?: GraphArtifactReceipt): GraphReceipt | null {
  try {
    const graphReceipt = supplied ?? readGraphArtifactReceipt(graphPath)
    if (supplied && validateGraphPath(graphPath) !== graphReceipt.graphPath) return null
    const { graph, graphSha256, graphModifiedMs } = graphReceipt
    return { graph, state: readBuildState(graph), graphSha256, graphModifiedMs }
  } catch { return null }
}
export function loadAcceptedIndex(graphPath: string): AcceptedIndex | null {
  const receipt = loadGraphReceipt(graphPath); return receipt?.state ? { ...receipt, state: receipt.state } : null
}
function readMatchingJson<T extends BoundArtifact>(graphPath: string, receipt: GraphReceipt | null, name: string, parse: ArtifactParser<T>): T | null {
  if (!receipt?.state) return null
  try {
    const value = parse(JSON.parse(readFileSync(join(dirname(graphPath), name), 'utf8')))
    return value?.version === INDEX_DIAGNOSTICS_VERSION
      && value.build_id === receipt.state.build_id && value.graph_sha256 === receipt.graphSha256 ? value : null
  } catch { return null }
}
export function readMatchingDiagnostics(graphPath: string): IndexDiagnostics | null { return readMatchingJson(graphPath, loadAcceptedIndex(graphPath), 'indexing-manifest.json', parseDiagnostics) }
function matchingReport(graphPath: string, receipt: GraphReceipt | null): MatchingReportReceipt | null {
  if (!receipt) return null
  try {
    const descriptor = openSync(join(dirname(graphPath), 'GRAPH_REPORT.md'), 'r')
    let report: string; let reportModifiedMs: number
    try {
      const stats = fstatSync(descriptor)
      if (stats.size > MAX_REPORT_BYTES) return null
      report = readBoundedUtf8(descriptor, MAX_REPORT_BYTES, 'Graph report too large')
      reportModifiedMs = Math.trunc(stats.mtimeMs)
    } finally { closeSync(descriptor) }
    const buildId = receipt.state?.build_id ?? null
    return report.match(REPORT_GRAPH_SHA256)?.[1] === receipt.graphSha256
      && (!buildId || report.match(REPORT_BUILD_ID)?.[1] === buildId)
      ? { report, reportModifiedMs, graphSha256: receipt.graphSha256, graphModifiedMs: receipt.graphModifiedMs, buildId } : null
  } catch { return null }
}
export function readMatchingReportReceipt(graphPath: string, graphReceipt?: GraphArtifactReceipt): MatchingReportReceipt | null {
  return matchingReport(graphPath, loadGraphReceipt(graphPath, graphReceipt))
}
export function readMatchingReport(graphPath: string): string | null { return readMatchingReportReceipt(graphPath)?.report ?? null }
export function acceptedIndexArtifactsComplete(graphPath: string): boolean {
  const receipt = loadGraphReceipt(graphPath)
  return matchingReport(graphPath, receipt) !== null
    && readMatchingJson(graphPath, receipt, 'indexing-manifest.json', parseDiagnostics) !== null
    && readMatchingJson(graphPath, receipt, 'indexing-manifest.share-safe.json', parseShareSafeDiagnostics) !== null
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
function reclaimInUse(path: string): boolean {
  try {
    const stats = statSync(path); try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }; if (typeof record.pid === 'number'
        && Number.isSafeInteger(record.pid) && record.pid > 0) return processAlive(record.pid)
    } catch {}
    return Date.now() - stats.mtimeMs <= LOCK_STALE_MS
  } catch { return false }
}
function clearStaleLock(lockPath: string, dependencies: IndexLeaseDependencies): void {
  let observed: ReturnType<typeof statSync>
  try { observed = statSync(lockPath) } catch { return }
  if (Date.now() - observed.mtimeMs <= LOCK_STALE_MS) return
  const reclaimPath = `${lockPath}.reclaim-${observed.dev}-${observed.ino}`
  let reclaimDescriptor: number
  try { reclaimDescriptor = openSync(reclaimPath, 'wx', 0o600) } catch {
    if (reclaimInUse(reclaimPath)) return
    try { dependencies.unlink(reclaimPath); reclaimDescriptor = dependencies.open(reclaimPath) } catch { return }
  }
  try {
    dependencies.write(reclaimDescriptor, JSON.stringify({ pid: process.pid }))
    dependencies.hook?.('stale_reclaim_claimed')
    let current: ReturnType<typeof statSync>
    try { current = statSync(lockPath) } catch { return }
    if (current.dev !== observed.dev || current.ino !== observed.ino
      || Date.now() - current.mtimeMs <= LOCK_STALE_MS) return
    try {
      const record = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }
      if (typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0 && processAlive(record.pid)) return
    } catch {}
    dependencies.hook?.('before_stale_unlink')
    unlinkSync(lockPath)
  } catch {} finally {
    try { closeSync(reclaimDescriptor) } catch {}
    try { unlinkSync(reclaimPath) } catch {}
  }
}
export function releaseIndexLeaseOwner(outputDir: string, nonce: string, unlink: (path: string) => void = unlinkSync): void {
  const lockPath = join(resolve(outputDir), '.madar-build.lock')
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce?: unknown }
    if (record.nonce === nonce) unlink(lockPath)
  } catch {}
}
export function acquireIndexLease(outputDir: string, overrides: Partial<IndexLeaseDependencies> = {}, ownerToken: string = randomUUID()): () => void {
  const directory = resolve(outputDir)
  mkdirSync(directory, { recursive: true })
  const lockPath = join(directory, '.madar-build.lock')
  const dependencies = { ...DEFAULT_LEASE_DEPENDENCIES, ...overrides }
  clearStaleLock(lockPath, dependencies)
  let descriptor: number
  try { descriptor = dependencies.open(lockPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new IndexLeaseContentionError(directory)
    throw error
  }
  try {
    dependencies.write(descriptor, JSON.stringify({ pid: process.pid, nonce: ownerToken, acquired_at: new Date().toISOString() }))
    dependencies.close(descriptor)
  } catch (error) {
    try { dependencies.close(descriptor) } catch {}
    try { dependencies.unlink(lockPath) } catch {}
    throw error
  }
  return () => releaseIndexLeaseOwner(directory, ownerToken, dependencies.unlink)
}
