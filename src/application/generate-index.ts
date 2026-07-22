import { existsSync, realpathSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { buildCanonicalTypeScriptIndex, type CanonicalTypeScriptIndexResult } from '../adapters/typescript/index.js'
import { buildSourceCatalog, sourceCatalogStillCurrent, type SourceCatalog, type SourceCatalogOptions } from '../adapters/filesystem/source-catalog.js'
import {
  acquireIndexLease, INDEX_DIAGNOSTICS_VERSION, loadAcceptedIndex, publishAcceptedIndex,
  readMatchingDiagnostics, type IndexDiagnosticsInput, type IndexStoreDependencies,
} from '../adapters/filesystem/index-store.js'
import {
  attachBuildState, INDEX_BUILD_STATE_VERSION, INDEX_ENGINE_ID, type IndexBuildState,
  type IndexDiagnosticReceipt, type IndexingDiagnostic, type IndexingOutcome,
  type IndexingStrictThresholds, type IndexingSummary, type UpdateReceipt,
} from '../domain/index/build-state.js'
import { compareCodeUnits } from '../domain/graph/canonical-json.js'
import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { godNodes, semanticAnomalies, suggestQuestions, surprisingConnections } from '../pipeline/analyze.js'
import { cluster, scoreAll } from '../pipeline/cluster.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { generate as generateReport } from '../pipeline/report.js'
import { buildDiscoverySafetyMetadata, parseDiscoverySafetyMetadata, type DiscoverySafetyMetadata } from '../shared/discovery-safety.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'
export type ProgressStep =
  | { step: 'detect'; message: string }
  | { step: 'index'; message: string; current?: number; total?: number }
  | { step: 'build'; message: string }
  | { step: 'cluster'; message: string }
  | { step: 'analyze'; message: string }
  | { step: 'export'; message: string }
export interface GenerateIndexOptions extends SourceCatalogOptions {
  clusterOnly?: boolean; onProgress?: (progress: ProgressStep) => void
  storeDependencies?: Partial<IndexStoreDependencies>
}
type GenerateIndexMode = 'generate' | 'update' | 'cluster-only'
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
  const extension = extname(filePath).toLowerCase()
  if (extension === '.js') return 'builtin:index:javascript'
  if (extension === '.jsx') return 'builtin:index:jsx'
  return extension === '.tsx' ? 'builtin:index:tsx' : 'builtin:index:typescript'
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
    reason_buckets: Object.fromEntries(Object.entries(reasons).sort(([left], [right]) => compareCodeUnits(left, right))),
    capability_buckets: Object.fromEntries(Object.entries(capabilities).sort(([left], [right]) => compareCodeUnits(left, right))),
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
function canonicalMatchesCatalog(catalog: SourceCatalog, canonical: CanonicalTypeScriptIndexResult): boolean {
  if (canonical.files.length !== catalog.snapshot.supported.length) return false
  const indexed = new Map(canonical.files.map((file) =>
    [file.path.replaceAll('\\', '/').replace(/^\.\//, ''), file.hash]))
  return catalog.snapshot.supported.every((entry) => indexed.get(entry.path) === entry.hash)
}
function finalizeGraph(graph: KnowledgeGraph, rootPath: string, progress?: GenerateIndexOptions['onProgress']) {
  progress?.({ step: 'build', message: `Built graph: ${graph.numberOfNodes()} nodes, ${graph.numberOfEdges()} edges` })
  progress?.({ step: 'cluster', message: 'Clustering communities...' })
  const communities = cluster(graph)
  const cohesion = scoreAll(graph, communities)
  const labels = buildCommunityLabels(graph, communities, { rootPath })
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
export function indexResultFromState(input: {
  mode: GenerateIndexMode; rootPath: string; graph: KnowledgeGraph
  state: IndexBuildState; notes: string[]; updateReceipt?: UpdateReceipt
}) {
  const outputDir = resolveMadarOutputDirectory(input.rootPath)
  const communities = new Set(input.graph.nodeEntries()
    .map(([, attributes]) => attributes.community)
    .filter((value): value is number => typeof value === 'number' && value >= 0))
  const anomalies = Array.isArray(input.graph.graph.semantic_anomalies) ? input.graph.graph.semantic_anomalies.length : 0
  return {
    mode: input.mode,
    rootPath: input.rootPath,
    outputDir,
    graphPath: join(outputDir, 'graph.json'),
    reportPath: join(outputDir, 'GRAPH_REPORT.md'),
    totalFiles: input.state.corpus.supported_files,
    indexedFiles: input.state.completeness.summary.counts.indexed
      + input.state.completeness.summary.counts.indexed_with_warnings,
    totalWords: input.state.corpus.total_words,
    nodeCount: input.graph.numberOfNodes(),
    edgeCount: input.graph.numberOfEdges(),
    communityCount: communities.size,
    semanticAnomalyCount: anomalies,
    warning: input.state.corpus.warning,
    notes: input.notes,
    discoverySafety: parseDiscoverySafetyMetadata(input.graph.graph.discovery_safety) ?? buildDiscoverySafetyMetadata([]),
    indexingManifestPath: join(outputDir, 'indexing-manifest.json'),
    indexing: input.state.completeness.summary,
    buildId: input.state.build_id,
    ...(input.updateReceipt ? { updateReceipt: input.updateReceipt } : {}),
  }
}
export type GenerateIndexResult = ReturnType<typeof indexResultFromState>
function finalizeAndPublishIndex(input: {
  graph: KnowledgeGraph; rootPath: string; mode: GenerateIndexResult['mode']
  state: Omit<IndexBuildState, 'build_id'> & { build_id?: string }
  diagnostics: (state: IndexBuildState) => IndexDiagnosticsInput; notes: (diagnosticWarnings: string[]) => string[]
  options: GenerateIndexOptions
  updateReceipt?: Omit<UpdateReceipt, 'accepted_build_id' | 'publication_advanced'>
  assertCurrent?: () => void
}): GenerateIndexResult {
  const finalized = finalizeGraph(input.graph, input.rootPath, input.options.onProgress)
  const { build_id: _previousBuildId, ...nextState } = input.state
  const state = attachBuildState(input.graph, nextState)
  const discoverySafety = parseDiscoverySafetyMetadata(input.graph.graph.discovery_safety)
    ?? buildDiscoverySafetyMetadata([])
  const report = generateReport(
    input.graph, finalized.communities, finalized.cohesion, finalized.labels, finalized.godNodeList,
    finalized.surprises, finalized.anomalies, {
      total_files: state.corpus.supported_files,
      total_words: state.corpus.total_words,
      warning: state.corpus.warning,
      discovery_safety: discoverySafety.summary,
      indexing_completeness: state.completeness.summary,
    }, { input: 0, output: 0 }, input.rootPath, finalized.questions,
  )
  input.options.onProgress?.({ step: 'export', message: 'Writing outputs...' })
  const publication = publishAcceptedIndex({
    graph: input.graph,
    outputDir: resolveMadarOutputDirectory(input.rootPath),
    report,
    diagnostics: input.diagnostics(state),
    ...(input.assertCurrent ? { assertCurrent: input.assertCurrent } : {}),
    ...(input.options.storeDependencies ? { dependencies: input.options.storeDependencies } : {}),
  })
  const updateReceipt = input.updateReceipt ? {
    ...input.updateReceipt,
    accepted_build_id: state.build_id,
    publication_advanced: true,
  } : undefined
  return indexResultFromState({
    mode: input.mode,
    rootPath: input.rootPath,
    graph: input.graph,
    state,
    notes: input.notes(publication.diagnosticWarnings),
    ...(updateReceipt ? { updateReceipt } : {}),
  })
}
export function buildAndPublishIndex(input: {
  catalog: SourceCatalog; mode: 'generate' | 'update'; options?: GenerateIndexOptions
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
  const canonical = buildCanonicalTypeScriptIndex({ root: catalog.rootPath, files: catalog.supportedFiles })
  if (!canonicalMatchesCatalog(catalog, canonical)) throw new SourceChangedDuringBuildError()
  const canonicalReceipts = canonicalOutcomes(catalog, canonical)
  const outcomes = [
    ...catalog.outcomes.filter((entry) => !(
      entry.capability?.startsWith('builtin:index:') === true && entry.status === 'indexed'
    )),
    ...canonicalReceipts.outcomes,
  ].sort((left, right) => compareCodeUnits(left.path, right.path))
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
  const notes: string[] = []
  if (canonicalReceipts.diagnostics.length > 0) notes.push(`Canonical index reported ${canonicalReceipts.diagnostics.length} diagnostic(s).`)
  if (catalog.snapshot.unsupported.length > 0) notes.push(`${catalog.snapshot.unsupported.length} recognized unsupported file(s) are informational and do not reduce JS/TS completeness.`)
  if (catalog.discoverySafety.summary.total > 0) notes.push(`${catalog.discoverySafety.summary.total} safety exclusion(s) were not indexed.`)
  return finalizeAndPublishIndex({
    graph, rootPath: catalog.rootPath, mode: input.mode, options,
    state: {
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
      completeness: { summary, supported_failures: [] },
    },
    diagnostics: (state) => ({
      version: INDEX_DIAGNOSTICS_VERSION,
      build_id: state.build_id,
      generated_at: new Date().toISOString(),
      summary,
      outcomes,
      index_diagnostics: canonicalReceipts.diagnostics,
    }),
    notes: (warnings) => [...warnings, ...notes],
    assertCurrent: () => {
      if (!canonicalMatchesCatalog(catalog, canonical) || (input.verifyCurrent && !input.verifyCurrent())) {
        throw new SourceChangedDuringBuildError()
      }
    },
    ...(input.updateReceipt ? { updateReceipt: input.updateReceipt } : {}),
  })
}
function generateClusterOnly(root: string, options: GenerateIndexOptions): GenerateIndexResult {
  const graphPath = join(resolveMadarOutputDirectory(root), 'graph.json')
  const accepted = loadAcceptedIndex(graphPath)
  if (!accepted) throw new Error('--cluster-only requires a current authoritative graph. Run `madar generate .` first.')
  const storedRoot = accepted.state.source_root.root_path
  if (!existsSync(storedRoot) || realpathSync(storedRoot) !== realpathSync(root)) {
    throw new Error('--cluster-only graph belongs to a different source workspace.')
  }
  if (options.indexingStrict) throw new Error('--cluster-only cannot change indexing thresholds.')
  const matchingDiagnostics = readMatchingDiagnostics(graphPath)
  if (!matchingDiagnostics) throw new Error('--cluster-only requires matching index diagnostics. Run `madar generate . --update` to repair them first.')
  const { graph_sha256: _previousGraphSha256, ...diagnostics } = matchingDiagnostics
  return finalizeAndPublishIndex({
    graph: accepted.graph, rootPath: root, mode: 'cluster-only', options,
    state: accepted.state,
    diagnostics: (state) => ({ ...diagnostics, build_id: state.build_id }),
    notes: (warnings) => [
      'Re-clustered the accepted graph without scanning or indexing source files.',
      ...warnings,
    ],
  })
}
export function generateIndex(rootPath = '.', options: GenerateIndexOptions = {}): GenerateIndexResult {
  const root = resolve(rootPath)
  const outputDir = resolveMadarOutputDirectory(root)
  const release = acquireIndexLease(outputDir)
  try {
    if (options.clusterOnly) return generateClusterOnly(root, options)
    options.onProgress?.({ step: 'detect', message: 'Scanning files...' })
    const catalog = buildSourceCatalog(root, options)
    options.onProgress?.({
      step: 'detect',
      message: `Found ${catalog.snapshot.supported.length} supported file(s) (~${catalog.totalWords.toLocaleString()} words)`,
    })
    return buildAndPublishIndex({
      catalog, mode: 'generate', options,
      verifyCurrent: () => sourceCatalogStillCurrent(catalog, options),
    })
  } finally { release() }
}
