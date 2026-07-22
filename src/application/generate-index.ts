import { existsSync, realpathSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import {
  buildCanonicalTypeScriptIndex,
  createCanonicalTypeScriptIndexSession,
  type CanonicalTypeScriptIndexSession,
  type CanonicalTypeScriptIndexResult,
} from '../adapters/typescript/index.js'
import { buildSourceCatalog, type SourceCatalog, type SourceCatalogOptions } from '../adapters/filesystem/source-catalog.js'
import {
  acquireIndexLease,
  INDEX_DIAGNOSTICS_VERSION,
  loadAcceptedIndex,
  publishAcceptedIndex,
  readMatchingDiagnostics,
  type IndexDiagnostics,
  type IndexStoreDependencies,
} from '../adapters/filesystem/index-store.js'
import {
  attachBuildState,
  INDEX_BUILD_STATE_VERSION,
  INDEX_ENGINE_ID,
  type IndexDiagnosticReceipt,
  type IndexingDiagnostic,
  type IndexingOutcome,
  type IndexingStrictThresholds,
  type IndexingSummary,
  type UpdateReceipt,
} from '../domain/index/build-state.js'
import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { godNodes, semanticAnomalies, suggestQuestions, surprisingConnections } from '../pipeline/analyze.js'
import { cluster, scoreAll } from '../pipeline/cluster.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { generate as generateReport } from '../pipeline/report.js'
import type { DiscoverySafetyMetadata } from '../shared/discovery-safety.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'

export type ProgressStep =
  | { step: 'detect'; message: string }
  | { step: 'index'; message: string; current?: number; total?: number }
  | { step: 'build'; message: string }
  | { step: 'cluster'; message: string }
  | { step: 'analyze'; message: string }
  | { step: 'export'; message: string }
export interface GenerateIndexOptions extends SourceCatalogOptions {
  clusterOnly?: boolean
  onProgress?: (progress: ProgressStep) => void
  /** Fault-injection seam for the publication contract tests. */
  storeDependencies?: Partial<IndexStoreDependencies>
}
export interface GenerateIndexResult {
  mode: 'generate' | 'update' | 'cluster-only'
  rootPath: string
  outputDir: string
  graphPath: string
  reportPath: string
  totalFiles: number
  indexedFiles: number
  totalWords: number
  nodeCount: number
  edgeCount: number
  communityCount: number
  semanticAnomalyCount: number
  warning: string | null
  notes: string[]
  discoverySafety: DiscoverySafetyMetadata
  indexingManifestPath: string
  indexing: IndexingSummary
  buildId: string
  updateReceipt?: UpdateReceipt
  /** In-process seed used by watch/MCP; never serialized or persisted. */
  indexSession?: CanonicalTypeScriptIndexSession
}
export type GenerateUnsupportedCorpusCode = 'NO_SUPPORTED_FILES' | 'NO_GRAPH_NODES'
export class GenerateUnsupportedCorpusError extends Error {
  constructor(
    readonly code: GenerateUnsupportedCorpusCode,
    message: string,
    readonly discoverySafety?: DiscoverySafetyMetadata,
  ) {
    super(message)
    this.name = 'GenerateUnsupportedCorpusError'
  }
}
export class IndexingCompletenessError extends Error {
  constructor(
    readonly manifestPath: string,
    readonly summary: IndexingSummary,
    readonly violations: string[],
  ) {
    super(`Indexing publication thresholds failed: ${violations.join('; ')}.`)
    this.name = 'IndexingCompletenessError'
  }
}
export class SourceChangedDuringBuildError extends Error {
  constructor() {
    super('Source files changed while Madar was building the index; reconciliation must run again.')
    this.name = 'SourceChangedDuringBuildError'
  }
}
function supportedCapability(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.js': return 'builtin:index:javascript'
    case '.jsx': return 'builtin:index:jsx'
    case '.tsx': return 'builtin:index:tsx'
    default: return 'builtin:index:typescript'
  }
}
function canonicalOutcomes(catalog: SourceCatalog, result: CanonicalTypeScriptIndexResult) {
  const local = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '')
  const pathById = new Map(result.files.map((file) => [file.id, local(file.path)]))
  const fileByPath = new Map(result.files.map((file) => [local(file.path), file]))
  const byFileId = new Map<string, IndexingDiagnostic[]>()
  const global: IndexingDiagnostic[] = []
  const diagnostics = result.diagnostics.map((diagnostic): IndexDiagnosticReceipt => {
    const fileId = diagnostic.evidence?.file_id
    const path = fileId ? pathById.get(fileId) : undefined
    const projected: IndexingDiagnostic = {
      code: diagnostic.id,
      level: diagnostic.level === 'warn' ? 'warning' : diagnostic.level,
      message: diagnostic.message,
    }
    if (diagnostic.level !== 'info') {
      if (fileId && path) byFileId.set(fileId, [...(byFileId.get(fileId) ?? []), projected])
      else global.push(projected)
    }
    return {
      id: diagnostic.id,
      level: diagnostic.level,
      reason: 'canonical_diagnostic',
      ...(path ? { path } : {}),
      message: diagnostic.message,
    }
  })
  const outcomes = catalog.snapshot.supported.map((entry): IndexingOutcome => {
    const file = fileByPath.get(entry.path)
    if (!file) return {
      path: entry.path, kind: 'file', status: 'failed', reason: 'canonical_file_missing',
      capability: supportedCapability(entry.path),
    }
    const fileDiagnostics = [...(byFileId.get(file.id) ?? []), ...global]
    const failed = fileDiagnostics.some((diagnostic) => diagnostic.level === 'error')
    return {
      path: entry.path,
      kind: 'file',
      status: failed ? 'failed' : fileDiagnostics.length > 0 ? 'indexed_with_warnings' : 'indexed',
      reason: fileDiagnostics.length > 0 ? 'canonical_diagnostic' : 'indexed',
      capability: supportedCapability(entry.path),
      ...(fileDiagnostics.length > 0 ? { diagnostics: fileDiagnostics } : {}),
    }
  })
  return { outcomes, diagnostics }
}
function summarize(outcomes: readonly IndexingOutcome[]): IndexingSummary {
  const counts = { indexed: 0, indexed_with_warnings: 0, skipped_by_policy: 0, unsupported: 0, failed: 0 }
  const reasons: IndexingSummary['reason_buckets'] = {}
  const capabilities: Record<string, number> = {}
  for (const outcome of outcomes) {
    counts[outcome.status] += 1
    reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1
    const capability = outcome.capability ?? 'none'
    capabilities[capability] = (capabilities[capability] ?? 0) + 1
  }
  const supported = outcomes.filter((entry) => entry.capability?.startsWith('builtin:index:') === true)
  const supportedFailures = supported.filter((entry) => entry.status === 'failed').length
  return {
    state: supportedFailures === 0 ? 'complete' : supportedFailures === supported.length ? 'failed' : 'partial',
    candidates: outcomes.length,
    counts,
    reason_buckets: Object.fromEntries(Object.entries(reasons).sort(([left], [right]) => left.localeCompare(right))),
    capability_buckets: Object.fromEntries(Object.entries(capabilities).sort(([left], [right]) => left.localeCompare(right))),
  }
}

function thresholdViolations(summary: IndexingSummary, strict: IndexingStrictThresholds | undefined): string[] {
  if (!strict) return []
  const failures: string[] = []
  if (summary.counts.failed > strict.maxFailed) failures.push(`failed=${summary.counts.failed} exceeds maxFailed=${strict.maxFailed}`)
  if (summary.counts.unsupported > strict.maxUnsupported) failures.push(`unsupported=${summary.counts.unsupported} exceeds maxUnsupported=${strict.maxUnsupported}`)
  return failures
}

function missingCorpusError(catalog: SourceCatalog, code: GenerateUnsupportedCorpusCode): GenerateUnsupportedCorpusError {
  const base = code === 'NO_SUPPORTED_FILES'
    ? 'No supported TypeScript or JavaScript files were found in the target path.'
    : 'The canonical TypeScript/JavaScript index did not produce graph nodes from the detected source files.'
  return new GenerateUnsupportedCorpusError(code, base, catalog.discoverySafety)
}

function finalizeGraph(graph: KnowledgeGraph, catalog: SourceCatalog, progress?: GenerateIndexOptions['onProgress']) {
  progress?.({ step: 'build', message: `Built graph: ${graph.numberOfNodes()} nodes, ${graph.numberOfEdges()} edges` })
  progress?.({ step: 'cluster', message: 'Clustering communities...' })
  const communities = cluster(graph)
  const cohesion = scoreAll(graph, communities)
  const labels = buildCommunityLabels(graph, communities, { rootPath: catalog.rootPath })
  progress?.({ step: 'cluster', message: `Found ${Object.keys(communities).length} communities` })
  progress?.({ step: 'analyze', message: 'Analyzing structure...' })
  const godNodeList = godNodes(graph)
  const surprises = surprisingConnections(graph, communities)
  const anomalies = semanticAnomalies(graph, communities, labels)
  const questions = suggestQuestions(graph, communities, labels)
  graph.graph.community_labels = labels
  graph.graph.semantic_anomalies = anomalies
  for (const [nodeId, attributes] of graph.nodeEntries()) graph.replaceNodeAttributes(nodeId, { ...attributes, community: -1 })
  for (const [communityId, nodeIds] of Object.entries(communities)) {
    for (const nodeId of nodeIds) {
      if (graph.hasNode(nodeId)) graph.replaceNodeAttributes(nodeId, { ...graph.nodeAttributes(nodeId), community: Number(communityId) })
    }
  }
  return { communities, cohesion, labels, godNodeList, surprises, anomalies, questions }
}

export function buildAndPublishIndex(input: {
  catalog: SourceCatalog
  canonical?: CanonicalTypeScriptIndexResult
  mode: 'generate' | 'update'
  options?: GenerateIndexOptions
  updateReceipt?: Omit<UpdateReceipt, 'accepted_build_id' | 'publication_advanced'>
  verifyCurrent?: () => boolean
}): GenerateIndexResult {
  const { catalog } = input
  const options = input.options ?? {}
  if (catalog.supportedFiles.length === 0) throw missingCorpusError(catalog, 'NO_SUPPORTED_FILES')
  options.onProgress?.({
    step: 'index', message: `Indexing ${catalog.supportedFiles.length} TypeScript/JavaScript file(s)...`,
    current: 0, total: catalog.supportedFiles.length,
  })
  const canonical = input.canonical ?? buildCanonicalTypeScriptIndex({ root: catalog.rootPath, files: catalog.supportedFiles })
  const canonicalReceipts = canonicalOutcomes(catalog, canonical)
  const outcomes = [
    ...catalog.outcomes.filter((entry) => !(
      entry.capability?.startsWith('builtin:index:') === true && entry.status === 'indexed'
    )),
    ...canonicalReceipts.outcomes,
  ].sort((left, right) => left.path.localeCompare(right.path))
  const summary = summarize(outcomes)
  const outputDir = resolveMadarOutputDirectory(catalog.rootPath)
  const supportedIndexFailures = outcomes.filter((entry) =>
    entry.capability?.startsWith('builtin:index:') === true && entry.status === 'failed')
  const violations = [
    ...supportedIndexFailures.map((entry) => `${entry.path}: ${entry.reason}`),
    ...thresholdViolations(summary, options.indexingStrict),
  ]
  if (violations.length > 0) throw new IndexingCompletenessError(join(outputDir, 'indexing-manifest.json'), summary, violations)
  const graph = canonical.graph
  if (graph.numberOfNodes() === 0) throw missingCorpusError(catalog, 'NO_GRAPH_NODES')
  graph.graph.discovery_safety = catalog.discoverySafety
  const finalized = finalizeGraph(graph, catalog, options.onProgress)
  const supportedFailures = outcomes
    .filter((entry) => entry.capability?.startsWith('builtin:index:') === true && entry.status === 'failed')
    .map((entry) => ({ path: entry.path, reason: entry.reason }))
  const state = attachBuildState(graph, {
    version: INDEX_BUILD_STATE_VERSION,
    engine_id: INDEX_ENGINE_ID,
    policy: catalog.policy,
    sources: catalog.snapshot,
    source_root: catalog.sourceRoot,
    corpus: {
      supported_files: catalog.snapshot.supported.length,
      unsupported_files: catalog.snapshot.unsupported.length,
      total_words: catalog.totalWords,
      warning: catalog.warning,
    },
    completeness: { summary, supported_failures: supportedFailures },
  })
  const reportCorpus = {
    total_files: catalog.snapshot.supported.length,
    total_words: catalog.totalWords,
    warning: catalog.warning,
    discovery_safety: catalog.discoverySafety.summary,
    indexing_completeness: summary,
  }
  const report = generateReport(
    graph, finalized.communities, finalized.cohesion, finalized.labels, finalized.godNodeList,
    finalized.surprises, finalized.anomalies, reportCorpus, { input: 0, output: 0 },
    catalog.rootPath, finalized.questions,
  )
  const diagnostics: IndexDiagnostics = {
    version: INDEX_DIAGNOSTICS_VERSION,
    build_id: state.build_id,
    generated_at: new Date().toISOString(),
    summary,
    outcomes,
    index_diagnostics: canonicalReceipts.diagnostics,
  }
  if (input.verifyCurrent && !input.verifyCurrent()) throw new SourceChangedDuringBuildError()
  options.onProgress?.({ step: 'export', message: 'Writing outputs...' })
  const publication = publishAcceptedIndex({
    graph, outputDir, report, diagnostics,
    ...(options.storeDependencies ? { dependencies: options.storeDependencies } : {}),
  })
  const notes = [...publication.diagnosticWarnings]
  if (canonicalReceipts.diagnostics.length > 0) notes.push(`Canonical index reported ${canonicalReceipts.diagnostics.length} diagnostic(s).`)
  if (catalog.snapshot.unsupported.length > 0) notes.push(`${catalog.snapshot.unsupported.length} recognized unsupported file(s) are informational and do not reduce JS/TS completeness.`)
  if (catalog.discoverySafety.summary.total > 0) notes.push(`${catalog.discoverySafety.summary.total} safety exclusion(s) were not indexed.`)
  const updateReceipt = input.updateReceipt ? {
    ...input.updateReceipt,
    accepted_build_id: state.build_id,
    publication_advanced: true,
  } : undefined
  return {
    mode: input.mode,
    rootPath: catalog.rootPath,
    outputDir,
    graphPath: publication.graphPath,
    reportPath: publication.reportPath,
    totalFiles: catalog.snapshot.supported.length,
    indexedFiles: canonical.files.length,
    totalWords: catalog.totalWords,
    nodeCount: graph.numberOfNodes(),
    edgeCount: graph.numberOfEdges(),
    communityCount: Object.keys(finalized.communities).length,
    semanticAnomalyCount: finalized.anomalies.length,
    warning: catalog.warning,
    notes,
    discoverySafety: catalog.discoverySafety,
    indexingManifestPath: publication.diagnosticsPath,
    indexing: summary,
    buildId: state.build_id,
    ...(updateReceipt ? { updateReceipt } : {}),
  }
}

function generateClusterOnly(rootPath: string, options: GenerateIndexOptions): GenerateIndexResult {
  const root = resolve(rootPath)
  const outputDir = resolveMadarOutputDirectory(root)
  const graphPath = join(outputDir, 'graph.json')
  const accepted = loadAcceptedIndex(graphPath)
  if (!accepted) throw new Error('--cluster-only requires a current authoritative graph. Run `madar generate .` first.')
  const storedRoot = accepted.state.source_root.root_path
  if (!existsSync(storedRoot) || realpathSync(storedRoot) !== realpathSync(root)) {
    throw new Error('--cluster-only graph belongs to a different source workspace.')
  }
  if (options.indexingStrict) throw new Error('--cluster-only cannot change indexing thresholds.')
  const catalog: SourceCatalog = {
    rootPath: root,
    supportedFiles: accepted.state.sources.supported.map((entry) => resolve(root, entry.path)),
    snapshot: accepted.state.sources,
    policy: accepted.state.policy,
    sourceRoot: accepted.state.source_root,
    outcomes: readMatchingDiagnostics(graphPath)?.outcomes ?? [],
    discoverySafety: accepted.graph.graph.discovery_safety as DiscoverySafetyMetadata,
    totalWords: accepted.state.corpus.total_words,
    warning: accepted.state.corpus.warning,
    scannedFiles: 0,
  }
  const finalized = finalizeGraph(accepted.graph, catalog, options.onProgress)
  const state = attachBuildState(accepted.graph, {
    version: accepted.state.version,
    engine_id: accepted.state.engine_id,
    policy: accepted.state.policy,
    sources: accepted.state.sources,
    source_root: accepted.state.source_root,
    corpus: accepted.state.corpus,
    completeness: accepted.state.completeness,
  })
  const diagnostics = readMatchingDiagnostics(graphPath) ?? {
    version: INDEX_DIAGNOSTICS_VERSION,
    build_id: state.build_id,
    generated_at: new Date().toISOString(),
    summary: state.completeness.summary,
    outcomes: [],
    index_diagnostics: [],
  }
  diagnostics.build_id = state.build_id
  const report = generateReport(
    accepted.graph, finalized.communities, finalized.cohesion, finalized.labels, finalized.godNodeList,
    finalized.surprises, finalized.anomalies, {
      total_files: state.corpus.supported_files,
      total_words: state.corpus.total_words,
      warning: state.corpus.warning,
      discovery_safety: catalog.discoverySafety.summary,
      indexing_completeness: state.completeness.summary,
    }, { input: 0, output: 0 }, root, finalized.questions,
  )
  const publication = publishAcceptedIndex({
    graph: accepted.graph, outputDir, report, diagnostics,
    ...(options.storeDependencies ? { dependencies: options.storeDependencies } : {}),
  })
  return {
    mode: 'cluster-only', rootPath: root, outputDir, graphPath: publication.graphPath, reportPath: publication.reportPath,
    totalFiles: state.corpus.supported_files,
    indexedFiles: state.corpus.supported_files, totalWords: state.corpus.total_words,
    nodeCount: accepted.graph.numberOfNodes(), edgeCount: accepted.graph.numberOfEdges(),
    communityCount: Object.keys(finalized.communities).length, semanticAnomalyCount: finalized.anomalies.length,
    warning: state.corpus.warning, notes: ['Re-clustered the accepted graph without scanning or indexing source files.', ...publication.diagnosticWarnings],
    discoverySafety: catalog.discoverySafety,
    indexingManifestPath: publication.diagnosticsPath,
    indexing: state.completeness.summary, buildId: state.build_id,
  }
}

export function generateIndex(rootPath = '.', options: GenerateIndexOptions = {}): GenerateIndexResult {
  if (options.clusterOnly) return generateClusterOnly(rootPath, options)
  const root = resolve(rootPath)
  const outputDir = resolveMadarOutputDirectory(root)
  const release = acquireIndexLease(outputDir)
  try {
    options.onProgress?.({ step: 'detect', message: 'Scanning files...' })
    const catalog = buildSourceCatalog(root, options)
    options.onProgress?.({
      step: 'detect',
      message: `Found ${catalog.snapshot.supported.length} supported file(s) (~${catalog.totalWords.toLocaleString()} words)`,
    })
    const indexSession = createCanonicalTypeScriptIndexSession({ root, files: catalog.supportedFiles })
    const result = buildAndPublishIndex({ catalog, canonical: indexSession.result(), mode: 'generate', options })
    return { ...result, indexSession }
  } finally { release() }
}
