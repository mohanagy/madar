import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { loadGraphArtifact, writeGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { buildCanonicalTypeScriptIndex } from '../adapters/typescript/index.js'
import type {
  IndexingManifest,
  IndexingOutcome,
  IndexingStrictThresholds,
  IndexingSummary,
} from '../contracts/indexing.js'
import { GRAPH_ARTIFACT_REGENERATE_MESSAGE } from '../domain/graph/artifact.js'
import { canonicalJsonString } from '../domain/graph/canonical-json.js'
import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { godNodes, semanticAnomalies, suggestQuestions, surprisingConnections } from '../pipeline/analyze.js'
import { cluster, scoreAll } from '../pipeline/cluster.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import {
  createManifestSnapshot,
  type DetectResult,
  detect,
  FileType,
  loadManifestDocument, loadManifestMetadata,
  writeManifestSnapshot,
} from '../pipeline/detect.js'
import { canonicalTypeScriptIndexingOutcomes } from '../pipeline/indexing-generation.js'
import { createIndexingManifest, indexingStrictViolations, localIndexingPath } from '../pipeline/indexing-outcomes.js'
import { generate as generateReport } from '../pipeline/report.js'
import { writeTextFileAtomically } from '../shared/atomic-file.js'
import {
  buildDiscoverySafetyMetadata,
  parseDiscoverySafetyMetadata,
  type DiscoveryExclusion,
  type DiscoverySafetyMetadata,
} from '../shared/discovery-safety.js'
import { buildGraphBuildFreshnessMetadata } from '../shared/graph-build-freshness.js'
import { collectGitVisibleFiles } from '../shared/git.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'
import {
  INDEXING_MANIFEST_FILENAME,
  readIndexingManifestForGraph,
  writeFailedIndexingManifests,
  writeIndexingManifests,
} from './indexing-manifest.js'
import {
  buildGenerationPolicy,
  generationOptionsFromPolicy,
  readStoredGenerationPolicy,
} from './generation-policy.js'

export type ProgressStep =
  | { step: 'detect'; message: string }
  | { step: 'index'; message: string; current?: number; total?: number }
  | { step: 'build'; message: string }
  | { step: 'cluster'; message: string }
  | { step: 'analyze'; message: string }
  | { step: 'export'; message: string }

export interface GenerateGraphOptions {
  update?: boolean
  clusterOnly?: boolean
  followSymlinks?: boolean
  /** Restrict discovery to files that Git does not ignore. Falls back outside Git repositories. */
  respectGitignore?: boolean
  indexingStrict?: IndexingStrictThresholds
  onProgress?: (progress: ProgressStep) => void
}

export interface GenerateGraphResult {
  mode: 'generate' | 'update' | 'cluster-only'
  rootPath: string
  outputDir: string
  graphPath: string
  reportPath: string
  totalFiles: number
  codeFiles: number
  indexedFiles: number
  totalWords: number
  nodeCount: number
  edgeCount: number
  communityCount: number
  semanticAnomalyCount: number
  warning: string | null
  notes: string[]
  discoverySafety: DiscoverySafetyMetadata
  discoveryExclusions: DiscoveryExclusion[]
  indexingManifestPath: string
  indexingShareSafeManifestPath: string
  indexing: IndexingSummary
}

export type GenerateUnsupportedCorpusCode = 'NO_SUPPORTED_FILES' | 'NO_GRAPH_NODES'

export class GenerateUnsupportedCorpusError extends Error {
  readonly code: GenerateUnsupportedCorpusCode
  readonly discoverySafety: DiscoverySafetyMetadata | undefined

  constructor(code: GenerateUnsupportedCorpusCode, message: string, discoverySafety?: DiscoverySafetyMetadata) {
    super(message)
    this.name = 'GenerateUnsupportedCorpusError'
    this.code = code
    this.discoverySafety = discoverySafety
  }
}

export class IndexingCompletenessError extends Error {
  readonly manifestPath: string
  readonly summary: IndexingSummary
  readonly violations: string[]

  constructor(manifestPath: string, summary: IndexingSummary, violations: string[]) {
    super(`Indexing completeness thresholds failed: ${violations.join('; ')}. See ${manifestPath}.`)
    this.name = 'IndexingCompletenessError'
    this.manifestPath = manifestPath
    this.summary = summary
    this.violations = violations
  }
}

function detectOptions(
  options: GenerateGraphOptions,
  gitVisibleFiles: string[] | null,
): { followSymlinks?: boolean; includedFiles?: ReadonlySet<string> } {
  const includedFiles = gitVisibleFiles ? new Set(gitVisibleFiles.map((filePath) => resolve(filePath))) : undefined
  return {
    ...(options.followSymlinks ? { followSymlinks: true } : {}),
    ...(includedFiles ? { includedFiles } : {}),
  }
}

function detectionSummary(detection: DetectResult, indexing: IndexingSummary): Record<string, unknown> {
  return {
    files: detection.files,
    total_files: detection.total_files,
    total_words: detection.total_words,
    warning: detection.warning,
    discovery_safety: buildDiscoverySafetyMetadata(detection.exclusions).summary,
    indexing_completeness: indexing,
  }
}

function graphIndexingMetadata(manifest: IndexingManifest): Record<string, unknown> {
  return {
    version: manifest.version,
    generated_at: manifest.generated_at,
    summary: manifest.summary,
  }
}

const artifactDigest = (value: unknown): string => createHash('sha256').update(canonicalJsonString(value)).digest('hex')

function outputDirectory(rootPath: string): string {
  return resolveMadarOutputDirectory(rootPath)
}

function missingCanonicalIndexMessage(totalFiles: number, discoverySafety?: DiscoverySafetyMetadata): string {
  const baseMessage = totalFiles === 0
    ? 'No supported TypeScript or JavaScript files were found in the target path.'
    : 'The canonical TypeScript/JavaScript index did not produce graph nodes from the detected source files.'
  if (!discoverySafety || discoverySafety.summary.total === 0) return baseMessage
  const exclusions = discoverySafety.exclusions.slice(0, 20)
    .map((entry) => `- ${JSON.stringify(entry.path)} (${entry.reason})`)
  if (discoverySafety.exclusions.length > 20) {
    exclusions.push(`- ... ${discoverySafety.exclusions.length - 20} more safety exclusions`)
  }
  return [
    baseMessage,
    `Safety exclusions: ${discoverySafety.summary.total} (${discoverySafety.summary.sensitive} sensitive, ${discoverySafety.summary.unreadable} unreadable).`,
    ...exclusions,
  ].join('\n')
}

function missingCanonicalIndexError(
  totalFiles: number,
  discoverySafety?: DiscoverySafetyMetadata,
): GenerateUnsupportedCorpusError {
  return new GenerateUnsupportedCorpusError(
    totalFiles === 0 ? 'NO_SUPPORTED_FILES' : 'NO_GRAPH_NODES',
    missingCanonicalIndexMessage(totalFiles, discoverySafety),
    discoverySafety,
  )
}

function storedDiscoverySafety(graph: KnowledgeGraph): DiscoverySafetyMetadata {
  return parseDiscoverySafetyMetadata(graph.graph.discovery_safety) ?? buildDiscoverySafetyMetadata([])
}

const RETIRED_OUTPUTS = ['cache', 'docs', 'wiki', 'graph.html', 'graph-pages', 'graph.svg', 'graph.graphml', 'cypher.txt', 'obsidian']

function commitStagedPublication(outputDir: string, transactionDir: string, names: readonly string[], retired: readonly string[]): void {
  const [stageDir, backupDir] = ['staged', 'previous'].map((name) => join(transactionDir, name)) as [string, string]
  const moved: Array<[string, string]> = [], published: string[] = []
  mkdirSync(backupDir, { recursive: true })
  try {
    for (const [index, name] of [...new Set([...names, ...retired])].entries()) {
      const target = join(outputDir, name)
      if (!existsSync(target)) continue
      const backup = join(backupDir, String(index))
      renameSync(target, backup)
      moved.push([target, backup])
    }
    for (const name of names) {
      const target = join(outputDir, name)
      renameSync(join(stageDir, name), target)
      published.push(target)
    }
  } catch (error) {
    for (const target of published.reverse()) rmSync(target, { recursive: true, force: true })
    for (const [target, backup] of moved.reverse()) renameSync(backup, target)
    throw error
  } finally {
    try { rmSync(transactionDir, { recursive: true, force: true }) } catch { /* named retired outputs are already absent */ }
  }
}

export function generateGraph(rootPath = '.', options: GenerateGraphOptions = {}): GenerateGraphResult {
  if (options.update && options.clusterOnly) throw new Error('--update and --cluster-only cannot be used together')

  const resolvedRootPath = resolve(rootPath)
  const resolvedOutputDir = outputDirectory(resolvedRootPath)
  const graphPath = join(resolvedOutputDir, 'graph.json')
  const reportPath = join(resolvedOutputDir, 'GRAPH_REPORT.md')
  const manifestPath = join(resolvedOutputDir, 'manifest.json')
  const indexingManifestPath = join(resolvedOutputDir, INDEXING_MANIFEST_FILENAME)
  const mode: GenerateGraphResult['mode'] = options.clusterOnly ? 'cluster-only' : options.update ? 'update' : 'generate'
  const notes: string[] = []
  const progress = options.onProgress

  mkdirSync(resolvedOutputDir, { recursive: true })

  let graph: KnowledgeGraph
  let indexingManifest: IndexingManifest
  let discoverySafety: DiscoverySafetyMetadata
  let reportCorpus: Record<string, unknown>
  let totalFiles: number
  let codeFiles: number
  let indexedFiles: number
  let totalWords: number
  let warning: string | null
  let sourceManifestSnapshot: ReturnType<typeof createManifestSnapshot> | null = null

  if (options.clusterOnly) {
    if (!existsSync(graphPath)) {
      throw new Error('--cluster-only requires an existing graph. Run `madar generate .` first.')
    }
    graph = loadGraphArtifact(graphPath)
    const storedPolicy = readStoredGenerationPolicy(graphPath, manifestPath)
    if (!storedPolicy) {
      throw new Error(
        '--cluster-only requires the current canonical generation policy. Run `madar generate . --update` to regenerate the graph.',
      )
    }
    if (options.indexingStrict !== undefined) {
      throw new Error('--cluster-only cannot change indexing thresholds. Run `madar generate . --update` instead.')
    }
    const storedOptions = generationOptionsFromPolicy(storedPolicy)
    const currentPolicy = buildGenerationPolicy(resolvedRootPath, storedOptions, null)
    if (currentPolicy.fingerprint !== storedPolicy.fingerprint) {
      throw new Error(
        '--cluster-only cannot reuse a graph whose source controls changed. Run `madar generate . --update`.',
      )
    }
    const storedManifest = readIndexingManifestForGraph(graphPath)
    if (!storedManifest) {
      throw new Error(
        '--cluster-only requires the current indexing manifest. Run `madar generate . --update` to regenerate it.',
      )
    }
    const binding = graph.graph.publication_binding as { source_manifest_sha256?: unknown; indexing_manifest_sha256?: unknown } | undefined
    if (binding?.source_manifest_sha256 !== artifactDigest(loadManifestDocument(manifestPath)) || binding.indexing_manifest_sha256 !== artifactDigest(storedManifest)) {
      throw new Error('--cluster-only requires indexing metadata from the same generation. Run `madar generate . --update`.')
    }
    indexingManifest = storedManifest
    discoverySafety = storedDiscoverySafety(graph)
    indexedFiles = indexingManifest.summary.counts.indexed + indexingManifest.summary.counts.indexed_with_warnings
    codeFiles = indexingManifest.outcomes.filter((outcome) =>
      outcome.capability?.startsWith('builtin:index:') === true).length
    totalFiles = codeFiles
    totalWords = loadManifestMetadata(manifestPath).total_words ?? 0
    warning = null
    reportCorpus = {
      total_files: totalFiles,
      total_words: totalWords,
      warning: null,
      discovery_safety: discoverySafety.summary,
      indexing_completeness: indexingManifest.summary,
    }
    notes.push('Re-clustered and re-analyzed the existing canonical graph without scanning or indexing source files.')
  } else {
    if (options.update && existsSync(graphPath)) {
      try {
        loadGraphArtifact(graphPath)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes(GRAPH_ARTIFACT_REGENERATE_MESSAGE)) throw error
        notes.push('The previous graph used a retired artifact schema, so --update replaced it with a canonical graph.')
      }
      notes.push('--update performs a full canonical TypeScript/JavaScript rebuild.')
    }

    const gitVisibleFiles = options.respectGitignore ? collectGitVisibleFiles(resolvedRootPath) : null
    const generationPolicy = buildGenerationPolicy(resolvedRootPath, options, gitVisibleFiles)
    progress?.({ step: 'detect', message: 'Scanning TypeScript and JavaScript files...' })
    const detected = detect(resolvedRootPath, detectOptions(options, gitVisibleFiles))
    discoverySafety = buildDiscoverySafetyMetadata(detected.exclusions)
    const indexingOutcomes: IndexingOutcome[] = [...(detected.indexing_outcomes ?? [])]
    const detectedCodeFiles = detected.files[FileType.CODE]

    totalFiles = detected.total_files
    codeFiles = detectedCodeFiles.length
    totalWords = detected.total_words
    warning = detected.warning
    progress?.({
      step: 'detect',
      message: `Found ${detected.total_files} supported source file(s) (~${detected.total_words.toLocaleString()} words)`,
    })
    progress?.({
      step: 'index',
      message: `Indexing ${detectedCodeFiles.length} TypeScript/JavaScript file(s)...`,
      current: 0,
      total: detectedCodeFiles.length,
    })

    // Every non-cluster generation owns exactly one whole-program canonical index build.
    const canonical = buildCanonicalTypeScriptIndex({ root: resolvedRootPath, files: detectedCodeFiles })
    const canonicalIndexing = canonicalTypeScriptIndexingOutcomes({
      rootPath: resolvedRootPath,
      codeFiles: detectedCodeFiles,
      result: canonical,
    })
    indexingOutcomes.push(...canonicalIndexing.outcomes)
    indexedFiles = canonical.files.length

    sourceManifestSnapshot = createManifestSnapshot(detected.files, {
      total_words: detected.total_words,
      generation_policy: generationPolicy,
    })
    indexingOutcomes.push(...sourceManifestSnapshot.failedPaths.map((filePath): IndexingOutcome => ({
      path: localIndexingPath(resolvedRootPath, filePath),
      kind: 'file',
      status: 'failed',
      reason: 'manifest_stat_failed',
      capability: null,
    })))
    indexingManifest = createIndexingManifest({
      outcomes: indexingOutcomes,
      indexDiagnostics: canonicalIndexing.diagnostics,
    })

    if (canonicalIndexing.diagnostics.length > 0) {
      notes.push(
        `Canonical index reported ${canonicalIndexing.diagnostics.length} diagnostic(s); inspect ${indexingManifestPath}.`,
      )
    }
    if (indexingManifest.summary.state !== 'complete') {
      const counts = indexingManifest.summary.counts
      notes.push(
        `Indexing ${indexingManifest.summary.state}: ${counts.indexed} indexed, ${counts.indexed_with_warnings} with warnings, ${counts.skipped_by_policy} skipped by policy, ${counts.unsupported} unsupported, ${counts.failed} failed. See ${indexingManifestPath}.`,
      )
    }
    if (discoverySafety.summary.total > 0) {
      notes.push(
        `${discoverySafety.summary.total} safety exclusion(s) were not indexed (${discoverySafety.summary.sensitive} sensitive, ${discoverySafety.summary.unreadable} unreadable).`,
      )
    }

    if (options.indexingStrict) {
      const violations = indexingStrictViolations(indexingManifest.summary, options.indexingStrict)
      if (violations.length > 0) {
        const failedArtifacts = writeFailedIndexingManifests(resolvedOutputDir, indexingManifest)
        throw new IndexingCompletenessError(failedArtifacts.manifestPath, indexingManifest.summary, violations)
      }
    }

    graph = canonical.graph
    if (graph.numberOfNodes() === 0) {
      writeFailedIndexingManifests(resolvedOutputDir, indexingManifest)
      throw missingCanonicalIndexError(detected.total_files, discoverySafety)
    }
    graph.graph.indexing_completeness = graphIndexingMetadata(indexingManifest)
    graph.graph.discovery_safety = discoverySafety
    graph.graph.generation_policy = generationPolicy
    graph.graph.publication_binding = { source_manifest_sha256: artifactDigest(sourceManifestSnapshot.document), indexing_manifest_sha256: artifactDigest(indexingManifest) }
    graph.graph.graph_build_freshness = buildGraphBuildFreshnessMetadata(
      resolvedRootPath,
      graph.nodeEntries()
        .map(([, attributes]) => String(attributes.source_file ?? '').trim())
        .filter((sourceFile) => sourceFile.length > 0),
      {
        supportedReceiptPaths: detected.files.code,
        unsupportedReceiptPaths: indexingManifest.outcomes
          .filter((outcome) => outcome.kind === 'file' && outcome.status === 'unsupported')
          .map((outcome) => outcome.path),
        compilerControlPaths: detected.compiler_control_paths,
        followSymlinks: generationPolicy.settings.follow_symlinks,
        respectGitignore: generationPolicy.settings.respect_gitignore,
      },
    )
    reportCorpus = detectionSummary(detected, indexingManifest.summary)
  }

  graph.graph.indexing_completeness = graphIndexingMetadata(indexingManifest)
  graph.graph.discovery_safety = discoverySafety
  progress?.({ step: 'build', message: `Built graph: ${graph.numberOfNodes()} nodes, ${graph.numberOfEdges()} edges` })

  progress?.({ step: 'cluster', message: 'Clustering communities...' })
  const communities = cluster(graph)
  const cohesionScores = scoreAll(graph, communities)
  const communityLabels = buildCommunityLabels(graph, communities, { rootPath: resolvedRootPath })
  progress?.({ step: 'cluster', message: `Found ${Object.keys(communities).length} communities` })

  progress?.({ step: 'analyze', message: 'Analyzing structure...' })
  const godNodeList = godNodes(graph)
  const surpriseList = surprisingConnections(graph, communities)
  const semanticAnomalyList = semanticAnomalies(graph, communities, communityLabels)
  const suggestedQuestions = suggestQuestions(graph, communities, communityLabels)

  graph.graph.community_labels = communityLabels
  graph.graph.semantic_anomalies = semanticAnomalyList
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    graph.replaceNodeAttributes(nodeId, { ...attributes, community: -1 })
  }
  for (const [communityId, nodeIds] of Object.entries(communities)) {
    for (const nodeId of nodeIds) {
      if (!graph.hasNode(nodeId)) continue
      graph.replaceNodeAttributes(nodeId, {
        ...graph.nodeAttributes(nodeId),
        community: Number(communityId),
      })
    }
  }

  const report = generateReport(
    graph,
    communities,
    cohesionScores,
    communityLabels,
    godNodeList,
    surpriseList,
    semanticAnomalyList,
    reportCorpus,
    { input: 0, output: 0 },
    resolvedRootPath,
    suggestedQuestions,
  )

  progress?.({ step: 'export', message: 'Writing outputs...' })
  const indexingArtifacts = { manifestPath: indexingManifestPath, shareSafeManifestPath: join(resolvedOutputDir, 'indexing-manifest.share-safe.json') }
  const transactionDir = join(resolvedOutputDir, `.madar-publication-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const stageDir = join(transactionDir, 'staged')
  const publishedNames = ['GRAPH_REPORT.md']
  try {
    mkdirSync(stageDir, { recursive: true })
    writeTextFileAtomically(join(stageDir, 'GRAPH_REPORT.md'), `${report}\n`)
    if (!options.clusterOnly && sourceManifestSnapshot) {
      writeIndexingManifests(stageDir, indexingManifest)
      writeManifestSnapshot(sourceManifestSnapshot, join(stageDir, 'manifest.json'))
      publishedNames.push(INDEXING_MANIFEST_FILENAME, 'indexing-manifest.share-safe.json', 'manifest.json')
    }
    writeGraphArtifact(graph, join(stageDir, 'graph.json'))
    publishedNames.push('graph.json')
    const failedNames = options.clusterOnly ? [] : ['indexing-manifest.failed.json', 'indexing-manifest.failed.share-safe.json']
    commitStagedPublication(resolvedOutputDir, transactionDir, publishedNames, [...RETIRED_OUTPUTS, ...failedNames])
  } catch (error) {
    rmSync(transactionDir, { recursive: true, force: true })
    throw error
  }

  return {
    mode,
    rootPath: resolvedRootPath,
    outputDir: resolvedOutputDir,
    graphPath,
    reportPath,
    totalFiles,
    codeFiles,
    indexedFiles,
    totalWords,
    nodeCount: graph.numberOfNodes(),
    edgeCount: graph.numberOfEdges(),
    communityCount: Object.keys(communities).length,
    semanticAnomalyCount: semanticAnomalyList.length,
    warning,
    notes,
    discoverySafety,
    discoveryExclusions: discoverySafety.exclusions,
    indexingManifestPath: indexingArtifacts.manifestPath,
    indexingShareSafeManifestPath: indexingArtifacts.shareSafeManifestPath,
    indexing: indexingManifest.summary,
  }
}
