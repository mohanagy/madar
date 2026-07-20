import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { loadGraphArtifact, writeGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { parseGenerationPolicy, type ExtractionMode } from '../contracts/generation-policy.js'
import type {
  ExtractionFallbackReason,
  ExtractionStrategy,
  IndexingManifestV1,
  IndexingOutcome,
  IndexingSpiDiagnostic,
  IndexingStrictThresholds,
  IndexingSummary,
} from '../contracts/indexing.js'
import type { ExtractionData, ExtractionEdge, ExtractionNode, ExtractionSchemaVersion, Hyperedge } from '../contracts/types.js'
import { GRAPH_ARTIFACT_REGENERATE_MESSAGE } from '../domain/graph/artifact.js'
import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { godNodes, semanticAnomalies, suggestQuestions, surprisingConnections } from '../pipeline/analyze.js'
import { buildGraphFromExtraction } from '../application/build-graph.js'
import { cluster, scoreAll } from '../pipeline/cluster.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import {
  createManifestSnapshot,
  type DetectResult,
  detect,
  detectIncremental,
  FileType,
  loadManifestMetadata,
  writeManifestSnapshot,
} from '../pipeline/detect.js'
import { generateDocs as generateDocsArtifacts } from '../pipeline/docs.js'
import { extract, EXTRACTOR_CACHE_VERSION } from '../pipeline/extract.js'
import { createFileStemMap } from '../pipeline/extract/core.js'
import {
  localExtractionIndexingOutcome,
  projectSpiIndexingOutcomes,
  retainedIndexingOutcomes,
} from '../pipeline/indexing-generation.js'
import { createIndexingManifest, indexingStrictViolations, localIndexingPath } from '../pipeline/indexing-outcomes.js'
import { buildSpiCached, type SpiCacheStats } from '../pipeline/spi/cache.js'
import { isSpiSupportedSourceFile } from '../pipeline/spi/build.js'
import { projectSpiToExtraction } from '../pipeline/spi/projector.js'
import { generate as generateReport } from '../pipeline/report.js'
import { toWiki } from '../pipeline/wiki.js'
import { buildGraphBuildFreshnessMetadata } from '../shared/graph-build-freshness.js'
import { collectGitVisibleFiles } from '../shared/git.js'
import { writeTextFileAtomically } from '../shared/atomic-file.js'
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
  resolveExtractionMode,
} from './generation-policy.js'
import {
  buildDiscoverySafetyMetadata,
  type DiscoveryExclusion,
  type DiscoverySafetyMetadata,
} from '../shared/discovery-safety.js'

export type ProgressStep =
  | { step: 'detect'; message: string }
  | { step: 'extract'; message: string; current?: number; total?: number }
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
  wiki?: boolean
  includeDocs?: boolean
  docs?: boolean
  /** Select capability-aware auto extraction, legacy-only extraction, or
   * strict SPI code extraction without unsupported-language fallback.
   * Eligible non-code evidence remains included. CLI and programmatic
   * generation default to `auto`; explicit `useSpi` retains its legacy
   * compatibility mapping. */
  extractionMode?: ExtractionMode
  /** @deprecated Use `extractionMode`. Retained for programmatic callers. */
  useSpi?: boolean
  indexingStrict?: IndexingStrictThresholds
  onProgress?: (progress: ProgressStep) => void
}

export interface GenerateGraphResult {
  mode: 'generate' | 'update' | 'cluster-only'
  /** User-facing requested extraction mode used for this graph. */
  extractionMode?: ExtractionMode
  rootPath: string
  outputDir: string
  graphPath: string
  reportPath: string
  wikiPath: string | null
  docsPath: string | null
  totalFiles: number
  codeFiles: number
  nonCodeFiles: number
  extractableFiles: number
  extractedFiles: number
  totalWords: number
  nodeCount: number
  edgeCount: number
  communityCount: number
  semanticAnomalyCount?: number
  changedFiles: number
  deletedFiles: number
  cache: GenerateGraphCacheSummary | null
  warning: string | null
  notes: string[]
  discoverySafety?: DiscoverySafetyMetadata
  discoveryExclusions?: DiscoveryExclusion[]
  indexingManifestPath?: string
  indexingShareSafeManifestPath?: string
  indexing?: IndexingSummary
}

export interface GenerateGraphCacheSummary {
  strategy: 'spi'
  hit: boolean
  reason: SpiCacheStats['reason']
  fileCount: number
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

type IncrementalDetectResult = ReturnType<typeof detectIncremental>

function detectOptions(options: GenerateGraphOptions, gitVisibleFiles: string[] | null): { followSymlinks?: boolean; includedFiles?: ReadonlySet<string> } {
  const includedFiles = gitVisibleFiles ? new Set(gitVisibleFiles.map((filePath) => resolve(filePath))) : undefined
  return {
    ...(options.followSymlinks ? { followSymlinks: true } : {}),
    ...(includedFiles ? { includedFiles } : {}),
  }
}

function countNonCodeFiles(files: DetectResult['files']): number {
  return files[FileType.DOCUMENT].length + files[FileType.PAPER].length + files[FileType.IMAGE].length + files[FileType.AUDIO].length + files[FileType.VIDEO].length
}

function detectionSummary(detection: DetectResult, indexing?: IndexingSummary): Record<string, unknown> {
  const discoverySafety = buildDiscoverySafetyMetadata(detection.exclusions)
  return {
    files: detection.files,
    total_files: detection.total_files,
    total_words: detection.total_words,
    warning: detection.warning,
    discovery_safety: discoverySafety.summary,
    ...(indexing ? { indexing_completeness: indexing } : {}),
  }
}

function graphIndexingMetadata(manifest: IndexingManifestV1): Record<string, unknown> {
  return {
    version: manifest.version,
    generated_at: manifest.generated_at,
    ...(manifest.requested_extraction_mode
      ? { requested_extraction_mode: manifest.requested_extraction_mode }
      : {}),
    summary: manifest.summary,
  }
}

function collectExtractableFiles(files: DetectResult['files']): string[] {
  return [...files[FileType.CODE], ...files[FileType.DOCUMENT], ...files[FileType.PAPER], ...files[FileType.IMAGE], ...files[FileType.AUDIO], ...files[FileType.VIDEO]]
}

function emptyExtraction(): ExtractionData {
  return {
    schema_version: 1,
    nodes: [],
    edges: [],
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  }
}

/**
 * Extraction fragments intentionally retain their language-level provenance
 * (for example builtin:extract:go). This receipt is separate: it records the
 * pipeline route that emitted the evidence, including auto's legacy fallback.
 * Apply it after extraction so per-file cache entries stay mode-neutral.
 */
function withExtractionStrategy(
  extraction: ExtractionData,
  extractionStrategy: ExtractionStrategy,
): ExtractionData {
  return {
    ...extraction,
    nodes: extraction.nodes.map((node) => ({ ...node, extraction_strategy: extractionStrategy })),
    edges: extraction.edges.map((edge) => ({ ...edge, extraction_strategy: extractionStrategy })),
    ...(extraction.hyperedges
      ? { hyperedges: extraction.hyperedges.map((hyperedge) => ({ ...hyperedge, extraction_strategy: extractionStrategy })) }
      : {}),
  }
}

function mergeSchemaVersion(current: ExtractionData['schema_version'], next: ExtractionData['schema_version']): ExtractionSchemaVersion {
  if (current === 2 || next === 2) {
    return 2
  }

  return 1
}

function mergeExtractions(extractions: ExtractionData[]): ExtractionData {
  return extractions.reduce<ExtractionData>((combined, extraction) => {
    combined.schema_version = mergeSchemaVersion(combined.schema_version, extraction.schema_version)
    combined.nodes.push(...extraction.nodes)
    combined.edges.push(...extraction.edges)
    if (extraction.hyperedges && extraction.hyperedges.length > 0) {
      combined.hyperedges = [...(combined.hyperedges ?? []), ...extraction.hyperedges]
    }
    combined.input_tokens = (combined.input_tokens ?? 0) + (extraction.input_tokens ?? 0)
    combined.output_tokens = (combined.output_tokens ?? 0) + (extraction.output_tokens ?? 0)
    return combined
  }, emptyExtraction())
}

function sourceFileKey(sourceFile: unknown): string | null {
  return typeof sourceFile === 'string' && sourceFile.length > 0 ? resolve(sourceFile) : null
}

function indexedSourceFilesFromGraph(graph: KnowledgeGraph | null, rootPath: string): ReadonlySet<string> | undefined {
  if (!graph) {
    return undefined
  }
  return new Set(
    graph.nodeEntries().flatMap(([, attributes]) => {
      const sourceFile = typeof attributes.source_file === 'string' ? attributes.source_file.trim() : ''
      return sourceFile.length > 0 ? [resolve(rootPath, sourceFile)] : []
    }),
  )
}

function retainedExtractionFromGraph(graph: KnowledgeGraph, removedSourceFiles: ReadonlySet<string>): ExtractionData {
  const nodes: ExtractionNode[] = graph
    .nodeEntries()
    .filter(([, attributes]) => {
      const sourceFile = sourceFileKey(attributes.source_file)
      return !sourceFile || !removedSourceFiles.has(sourceFile)
    })
    .map(([id, attributes]) => ({
      id,
      ...attributes,
      label: String(attributes.label ?? id),
      file_type: String(attributes.file_type ?? 'code') as ExtractionNode['file_type'],
      source_file: String(attributes.source_file ?? ''),
    }))

  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges: ExtractionEdge[] = graph
    .edgeEntries()
    .filter(([source, target, attributes]) => {
      const sourceFile = sourceFileKey(attributes.source_file)
      return nodeIds.has(source) && nodeIds.has(target) && (!sourceFile || !removedSourceFiles.has(sourceFile))
    })
    .map(([source, target, attributes]) => ({
      source,
      target,
      ...attributes,
      relation: String(attributes.relation ?? 'related_to'),
      confidence: String(attributes.confidence ?? 'EXTRACTED') as ExtractionEdge['confidence'],
      source_file: String(attributes.source_file ?? ''),
    }))

  const hyperedges = (Array.isArray(graph.graph.hyperedges) ? graph.graph.hyperedges : []).filter((hyperedge): hyperedge is Hyperedge => {
    if (!hyperedge || typeof hyperedge !== 'object' || Array.isArray(hyperedge)) {
      return false
    }

    const sourceFile = sourceFileKey((hyperedge as Hyperedge).source_file)
    if (sourceFile && removedSourceFiles.has(sourceFile)) {
      return false
    }

    return Array.isArray((hyperedge as Hyperedge).nodes) && (hyperedge as Hyperedge).nodes.every((nodeId) => nodeIds.has(nodeId))
  })

  return {
    schema_version: graph.graph.schema_version === 2 ? 2 : 1,
    nodes,
    edges,
    hyperedges,
    input_tokens: 0,
    output_tokens: 0,
  }
}

function isIncrementalDetectResult(detection: DetectResult | IncrementalDetectResult): detection is IncrementalDetectResult {
  return 'new_total' in detection && 'new_files' in detection && 'deleted_files' in detection
}

function outputDirectory(rootPath: string): string {
  return resolveMadarOutputDirectory(rootPath)
}

function missingCodeExtractionMessage(totalFiles: number, discoverySafety?: DiscoverySafetyMetadata): string {
  const baseMessage = totalFiles === 0
    ? 'No supported files were found in the target path.'
    : 'No graph nodes could be generated from the detected corpus. The current TypeScript extractor supports Python, JavaScript/TypeScript, documents, text-like papers, and image assets, but some detected formats still have shallow coverage.'
  if (!discoverySafety || discoverySafety.summary.total === 0) {
    return baseMessage
  }

  const exclusions = discoverySafety.exclusions
    .slice(0, 20)
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

function missingCodeExtractionError(totalFiles: number, discoverySafety?: DiscoverySafetyMetadata): GenerateUnsupportedCorpusError {
  return new GenerateUnsupportedCorpusError(
    totalFiles === 0 ? 'NO_SUPPORTED_FILES' : 'NO_GRAPH_NODES',
    missingCodeExtractionMessage(totalFiles, discoverySafety),
    discoverySafety,
  )
}

export function loadGraphExtractorVersion(graphPath: string): number | null {
  if (!existsSync(graphPath)) return null
  const extractorVersion = loadGraphArtifact(graphPath).graph.extractor_version
  return typeof extractorVersion === 'number' && Number.isFinite(extractorVersion) ? extractorVersion : null
}

export function generateGraph(rootPath = '.', options: GenerateGraphOptions = {}): GenerateGraphResult {
  if (options.update && options.clusterOnly) {
    throw new Error('--update and --cluster-only cannot be used together')
  }

  const resolvedRootPath = resolve(rootPath)
  const resolvedOutputDir = outputDirectory(resolvedRootPath)
  const graphPath = join(resolvedOutputDir, 'graph.json')
  const reportPath = join(resolvedOutputDir, 'GRAPH_REPORT.md')
  const wikiPath = options.wiki ? join(resolvedOutputDir, 'wiki') : null
  const manifestPath = join(resolvedOutputDir, 'manifest.json')

  mkdirSync(resolvedOutputDir, { recursive: true })
  const progress = options.onProgress

  progress?.({ step: 'detect', message: 'Scanning files...' })
  const graphExists = existsSync(graphPath)
  let existingArtifact: KnowledgeGraph | null = null
  try {
    existingArtifact = graphExists ? loadGraphArtifact(graphPath) : null
  } catch (error) {
    if (!options.update || !(error instanceof Error) || !error.message.includes(GRAPH_ARTIFACT_REGENERATE_MESSAGE)) throw error
  }
  const graphGenerationPolicy = existingArtifact ? parseGenerationPolicy(existingArtifact.graph.generation_policy) : null
  if (options.clusterOnly && !graphGenerationPolicy) {
    throw new Error(
      '--cluster-only requires valid generation-policy metadata. Run `madar generate . --update` to migrate and re-extract the graph first.',
    )
  }
  const storedClusterOptions = options.clusterOnly && graphGenerationPolicy
    ? generationOptionsFromPolicy(graphGenerationPolicy)
    : null
  if (
    options.clusterOnly
    && options.extractionMode !== undefined
    && storedClusterOptions
    && options.extractionMode !== storedClusterOptions.extractionMode
  ) {
    throw new Error(
      `--cluster-only cannot change extraction mode from ${storedClusterOptions.extractionMode} to ${options.extractionMode}. Run \`madar generate . --update\` instead.`,
    )
  }
  const corpusOptions = storedClusterOptions ?? options
  const extractionMode = resolveExtractionMode(corpusOptions)
  const gitVisibleFiles = corpusOptions.respectGitignore ? collectGitVisibleFiles(resolvedRootPath) : null
  if (storedClusterOptions && graphGenerationPolicy) {
    const currentStoredPolicy = buildGenerationPolicy(resolvedRootPath, storedClusterOptions, EXTRACTOR_CACHE_VERSION, gitVisibleFiles)
    if (currentStoredPolicy.fingerprint !== graphGenerationPolicy.fingerprint) {
      throw new Error(
        '--cluster-only cannot reuse a graph whose generation policy no longer matches current exclusion controls. Run `madar generate . --update`.',
      )
    }
  }
  const generationPolicy = buildGenerationPolicy(
    resolvedRootPath,
    storedClusterOptions
      ? {
          ...storedClusterOptions,
          ...(options.indexingStrict ? { indexingStrict: options.indexingStrict } : {}),
        }
      : options,
    EXTRACTOR_CACHE_VERSION,
    gitVisibleFiles,
  )
  const manifestGenerationPolicy = existsSync(manifestPath) ? loadManifestMetadata(manifestPath).generation_policy ?? null : null
  const storedPolicyMatches = graphGenerationPolicy?.fingerprint === generationPolicy.fingerprint
    && manifestGenerationPolicy?.fingerprint === generationPolicy.fingerprint
  const generationPolicyMismatch = options.update === true && graphExists && (!existingArtifact || !storedPolicyMatches)
  const detectionOptions = detectOptions(corpusOptions, gitVisibleFiles)
  const detected = options.update && !generationPolicyMismatch
    ? detectIncremental(resolvedRootPath, manifestPath, detectionOptions)
    : detect(resolvedRootPath, detectionOptions)
  const discoverySafety = buildDiscoverySafetyMetadata(detected.exclusions)
  const previousIndexingManifest = readIndexingManifestForGraph(graphPath)
  const indexingOutcomes: IndexingOutcome[] = (detected.indexing_outcomes ?? []).map((outcome) => ({
    ...outcome,
    extraction_strategy: outcome.extraction_strategy ?? 'not_extracted',
  }))
  const spiDiagnostics: IndexingSpiDiagnostic[] = []
  const recordExtractionOutcome = (
    extractionStrategy: ExtractionStrategy,
    fallbackReason?: ExtractionFallbackReason,
  ) => (outcome: Parameters<typeof localExtractionIndexingOutcome>[1]): void => {
    indexingOutcomes.push(localExtractionIndexingOutcome(resolvedRootPath, outcome, {
      extractionStrategy,
      ...(fallbackReason ? { fallbackReason } : {}),
    }))
  }

  if (corpusOptions.includeDocs === false) {
    indexingOutcomes.push(...detected.files[FileType.DOCUMENT].map((filePath): IndexingOutcome => ({
      path: localIndexingPath(resolvedRootPath, filePath),
      kind: 'file',
      status: 'skipped_by_policy',
      reason: 'docs_disabled',
      capability: null,
      extraction_strategy: 'not_extracted',
    })))
    detected.files[FileType.DOCUMENT] = []
    if (isIncrementalDetectResult(detected)) {
      detected.new_files[FileType.DOCUMENT] = []
      detected.unchanged_files[FileType.DOCUMENT] = []
    }
  }
  const notes: string[] = []
  const mode: GenerateGraphResult['mode'] = options.clusterOnly ? 'cluster-only' : options.update ? 'update' : 'generate'

  notes.push(`Extraction mode: ${extractionMode}.`)

  if (generationPolicyMismatch) {
    notes.push(
      graphGenerationPolicy && manifestGenerationPolicy
        ? 'Generation policy changed, so --update rebuilt the full graph instead of reusing incompatible extraction state.'
        : 'Existing graph predates complete generation-policy metadata, so --update rebuilt the full graph.',
    )
  }

  if (options.clusterOnly) {
    notes.push('Re-clustered the existing graph without re-extracting source files.')
  }

  const nonCodeFiles = countNonCodeFiles(detected.files)
  if (nonCodeFiles > 0) {
    notes.push(`${nonCodeFiles} non-code file(s) were included in extraction alongside source code.`)
  }
  if (discoverySafety.summary.total > 0) {
    notes.push(
      `${discoverySafety.summary.total} safety exclusion(s) were not indexed (${discoverySafety.summary.sensitive} sensitive, ${discoverySafety.summary.unreadable} unreadable).`,
    )
  }

  let changedFiles = 0
  let deletedFiles = 0
  if (isIncrementalDetectResult(detected)) {
    changedFiles = detected.new_total
    deletedFiles = detected.deleted_files.length

    const changedNonCodeFiles = countNonCodeFiles(detected.new_files)
    if (changedNonCodeFiles > 0) {
      notes.push(`${changedNonCodeFiles} changed non-code file(s) were included during --update.`)
    }

    if (deletedFiles > 0) {
      notes.push(`${deletedFiles} deleted file(s) were detected, so the graph was rebuilt from the current code corpus.`)
    }
  }

  const codeFiles = detected.files[FileType.CODE]
  const extractableFiles = collectExtractableFiles(detected.files)
  const nonCodeExtractableFiles = [
    ...detected.files[FileType.DOCUMENT],
    ...detected.files[FileType.PAPER],
    ...detected.files[FileType.IMAGE],
    ...detected.files[FileType.AUDIO],
    ...detected.files[FileType.VIDEO],
  ]
  const spiCodeFiles = extractionMode === 'legacy'
    ? []
    : extractionMode === 'spi'
      ? codeFiles
      : codeFiles.filter((filePath) => isSpiSupportedSourceFile(filePath))
  const legacyFallbackCodeFiles = extractionMode === 'auto'
    ? codeFiles.filter((filePath) => !isSpiSupportedSourceFile(filePath))
    : []
  // SPI contributes node and framework metadata for supported files, while
  // the legacy extractor preserves established relationship semantics for
  // those same files. This is an augmentation pass, not a fallback: explicit
  // --spi stays strict and explicit --legacy never invokes SPI.
  const legacyAugmentationCodeFiles = extractionMode === 'auto' ? spiCodeFiles : []
  // SPI code and non-code/legacy passes are merged afterward, so each output
  // graph needs one shared ID namespace across the files it actually emits.
  // Strict SPI intentionally excludes unsupported source languages from that
  // namespace: adding a Go/Python file must not alter JS/TS graph IDs.
  const sharedFileStems = extractionMode === 'auto'
    ? createFileStemMap(extractableFiles)
    : extractionMode === 'spi'
      ? createFileStemMap([
          ...codeFiles.filter((filePath) => isSpiSupportedSourceFile(filePath)),
          ...nonCodeExtractableFiles,
        ])
      : undefined
  let extractedFiles = options.clusterOnly ? 0 : extractableFiles.length
  let cacheSummary: GenerateGraphCacheSummary | null = null
  let spiProducedEvidence = false

  progress?.({ step: 'detect', message: `Found ${detected.total_files} files (~${detected.total_words.toLocaleString()} words)` })

  const loadedExistingGraph = options.clusterOnly || options.update ? existingArtifact : null
  const rawExistingExtractorVersion = loadedExistingGraph?.graph.extractor_version
  const existingGraphExtractorVersion = typeof rawExistingExtractorVersion === 'number' ? rawExistingExtractorVersion : null
  const generationPolicyToPublish = generationPolicy
  const existingGraph = generationPolicyMismatch ? null : loadedExistingGraph

  if (options.clusterOnly) {
    const retainedSourceFiles = indexedSourceFilesFromGraph(existingGraph, resolvedRootPath)
    indexingOutcomes.push(...retainedIndexingOutcomes({
      rootPath: resolvedRootPath,
      files: extractableFiles,
      previousManifest: previousIndexingManifest,
      ...(retainedSourceFiles ? { retainedSourceFiles } : {}),
    }))
  }

  if (!options.clusterOnly) {
    progress?.({ step: 'extract', message: `Extracting ${extractableFiles.length} files...`, current: 0, total: extractableFiles.length })
  }

  // SPI builds are all-or-nothing at the TypeScript-program layer. In auto
  // mode we run that cacheable build only for SPI-capable files, then merge
  // one legacy extraction for supported languages SPI does not implement.
  // Explicit --spi never falls back; explicit --legacy never invokes SPI.
  const buildViaSpi = (): ReturnType<typeof buildGraphFromExtraction> | null => {
    if (extractableFiles.length === 0) return null
    const spiExtractorVersion = `spi-v1.0.0-enqueues-job-${EXTRACTOR_CACHE_VERSION}`
    const built =
      spiCodeFiles.length > 0
        ? buildSpiCached({
            root: resolvedRootPath,
            madarVersion: `spi-extractor-${EXTRACTOR_CACHE_VERSION}`,
            extractorVersion: spiExtractorVersion,
            includedFiles: new Set(spiCodeFiles.map((filePath) => resolve(filePath))),
          })
        : null
    const spiExtraction = built
      ? withExtractionStrategy(projectSpiToExtraction(built.spi, {
          root: resolvedRootPath,
          ...(sharedFileStems ? { fileStemByAbsolutePath: sharedFileStems } : {}),
        }), 'spi')
      : emptyExtraction()
    spiProducedEvidence = spiExtraction.nodes.length > 0 || spiExtraction.edges.length > 0
    // Legacy owns the shared JS/TS nodes and their established relationship
    // semantics. Retain SPI-only nodes as supplemental evidence, but avoid
    // mixing competing relationship projections into the primary topology.
    const spiSupplementalExtraction: ExtractionData = {
      ...spiExtraction,
      edges: [],
      hyperedges: [],
    }
    const legacyAugmentationExtraction =
      legacyAugmentationCodeFiles.length > 0
        ? withExtractionStrategy(extract(legacyAugmentationCodeFiles, {
            allowedTargets: extractableFiles,
            contextNodes: spiExtraction.nodes,
            ...(sharedFileStems ? { fileStemByAbsolutePath: sharedFileStems } : {}),
          }), 'legacy')
        : emptyExtraction()
    const legacyFallbackExtraction =
      legacyFallbackCodeFiles.length > 0
        ? withExtractionStrategy(extract(legacyFallbackCodeFiles, {
            allowedTargets: extractableFiles,
            contextNodes: spiExtraction.nodes,
            ...(sharedFileStems ? { fileStemByAbsolutePath: sharedFileStems } : {}),
            onFileOutcome: recordExtractionOutcome('legacy_fallback', 'spi_unsupported_language'),
          }), 'legacy_fallback')
        : emptyExtraction()
    const codeExtraction = extractionMode === 'auto'
      ? mergeExtractions([
          legacyAugmentationExtraction,
          spiSupplementalExtraction,
          legacyFallbackExtraction,
        ])
      : spiExtraction
    const nonCodeExtraction =
      nonCodeExtractableFiles.length > 0
        ? withExtractionStrategy(extract(nonCodeExtractableFiles, {
            allowedTargets: extractableFiles,
            contextNodes: codeExtraction.nodes,
            ...(sharedFileStems ? { fileStemByAbsolutePath: sharedFileStems } : {}),
            onFileOutcome: recordExtractionOutcome('non_code'),
          }), 'non_code')
        : emptyExtraction()

    if (built) {
      const spiIndexing = projectSpiIndexingOutcomes({
        rootPath: resolvedRootPath,
        codeFiles: spiCodeFiles,
        result: built,
      })
      indexingOutcomes.push(...spiIndexing.outcomes)
      spiDiagnostics.push(...spiIndexing.diagnostics)
      if (spiIndexing.diagnostics.length > 0) {
        notes.push(`SPI reported ${spiIndexing.diagnostics.length} diagnostic(s); inspect ${join(resolvedOutputDir, 'indexing-manifest.json')}.`)
      }
    }

    extractedFiles = (built ? (built.cache.hit ? 0 : built.cache.file_count) : 0)
      + legacyAugmentationCodeFiles.length
      + legacyFallbackCodeFiles.length
      + nonCodeExtractableFiles.length
    cacheSummary = built
      ? {
          strategy: 'spi',
          hit: built.cache.hit,
          reason: built.cache.reason,
          fileCount: built.cache.file_count,
        }
      : null

    if (built) {
      if (built.cache.hit) {
        notes.push(`SPI cache hit (${built.cache.file_count} files, key ${built.cache.cache_key.slice(0, 8)}).`)
      } else {
        notes.push(`SPI build via projector (${built.cache.file_count} files, reason=${built.cache.reason}).`)
      }
    }
    if (extractionMode === 'auto') {
      notes.push(
        `Auto extraction: SPI routed ${spiCodeFiles.length} supported source file(s); legacy semantic augmentation routed ${legacyAugmentationCodeFiles.length} supported source file(s); legacy fallback routed ${legacyFallbackCodeFiles.length} SPI-unsupported source file(s).`,
      )
    }
    return buildGraphFromExtraction(mergeExtractions([codeExtraction, nonCodeExtraction]), { rootPath: resolvedRootPath })
  }

  const graph = options.clusterOnly
    ? existingGraph
    : extractionMode !== 'legacy'
      ? buildViaSpi()
    : options.update && existingGraph && isIncrementalDetectResult(detected)
        ? (() => {
            if (existingGraphExtractorVersion == null || existingGraphExtractorVersion !== EXTRACTOR_CACHE_VERSION) {
              notes.push(
                existingGraphExtractorVersion == null
                  ? 'Existing graph predates extractor version metadata, so --update rebuilt the full graph.'
                  : `Existing graph uses extractor version ${existingGraphExtractorVersion}, so --update rebuilt the full graph.`,
              )
              extractedFiles = extractableFiles.length
              return extractableFiles.length > 0
                ? buildGraphFromExtraction(withExtractionStrategy(extract(extractableFiles, {
                    onFileOutcome: recordExtractionOutcome('legacy'),
                  }), 'legacy'), { rootPath: resolvedRootPath })
                : null
            }

            const changedExtractableFiles = collectExtractableFiles(detected.new_files)
            const removedSourceFiles = new Set([...changedExtractableFiles, ...detected.deleted_files].map((filePath) => resolve(filePath)))

            if (changedExtractableFiles.length === 0 && detected.deleted_files.length === 0) {
              notes.push('No changed files detected - reused the existing graph.')
              extractedFiles = 0
              const retainedSourceFiles = indexedSourceFilesFromGraph(existingGraph, resolvedRootPath)
              indexingOutcomes.push(...retainedIndexingOutcomes({
                rootPath: resolvedRootPath,
                files: extractableFiles,
                previousManifest: previousIndexingManifest,
                ...(retainedSourceFiles ? { retainedSourceFiles } : {}),
              }))
              return existingGraph
            }

            const retainedExtraction = retainedExtractionFromGraph(existingGraph, removedSourceFiles)
            const changedExtraction =
              changedExtractableFiles.length > 0
                ? withExtractionStrategy(extract(changedExtractableFiles, {
                    allowedTargets: extractableFiles,
                    contextNodes: retainedExtraction.nodes,
                    onFileOutcome: recordExtractionOutcome('legacy'),
                  }), 'legacy')
                : emptyExtraction()
            const retainedSourceFiles = indexedSourceFilesFromGraph(existingGraph, resolvedRootPath)
            indexingOutcomes.push(...retainedIndexingOutcomes({
              rootPath: resolvedRootPath,
              files: collectExtractableFiles(detected.unchanged_files),
              previousManifest: previousIndexingManifest,
              ...(retainedSourceFiles ? { retainedSourceFiles } : {}),
            }))
            extractedFiles = changedExtractableFiles.length

            notes.push(
              `Incremental update re-extracted ${changedExtractableFiles.length} changed file(s) and retained ${new Set(retainedExtraction.nodes.map((node) => node.source_file)).size} unchanged file(s) from the existing graph.`,
            )

          return buildGraphFromExtraction(mergeExtractions([retainedExtraction, changedExtraction]), { rootPath: resolvedRootPath })
        })()
      : extractableFiles.length > 0
        ? buildGraphFromExtraction(withExtractionStrategy(extract(extractableFiles, {
            onFileOutcome: recordExtractionOutcome('legacy'),
          }), 'legacy'), { rootPath: resolvedRootPath })
      : options.update && existingGraph
          ? existingGraph
          : null

  const sourceManifestSnapshot = createManifestSnapshot(detected.files, {
    total_words: detected.total_words,
    generation_policy: generationPolicyToPublish,
  })
  indexingOutcomes.push(...sourceManifestSnapshot.failedPaths.map((filePath): IndexingOutcome => ({
    path: localIndexingPath(resolvedRootPath, filePath),
    kind: 'file',
    status: 'failed',
    reason: 'manifest_stat_failed',
    capability: null,
    extraction_strategy: 'not_extracted',
  })))
  // Discovery, retained-evidence, and manifest-stat outcomes never emit graph
  // evidence themselves. Normalize every remaining path here so the receipt
  // is total even during cluster-only and incremental reconciliation paths.
  const receiptOutcomes = indexingOutcomes.map((outcome) => ({
    ...outcome,
    extraction_strategy: outcome.extraction_strategy ?? 'not_extracted' as const,
  }))
  const indexingManifest = createIndexingManifest({
    outcomes: receiptOutcomes,
    spiDiagnostics,
    requestedExtractionMode: extractionMode,
  })
  const indexingManifestPath = join(resolvedOutputDir, INDEXING_MANIFEST_FILENAME)

  if (indexingManifest.summary.state !== 'complete') {
    const counts = indexingManifest.summary.counts
    notes.push(
      `Indexing ${indexingManifest.summary.state}: ${counts.indexed} indexed, ${counts.indexed_with_warnings} with warnings, ${counts.skipped_by_policy} skipped by policy, ${counts.unsupported} unsupported, ${counts.failed} failed. See ${indexingManifestPath}.`,
    )
  }

  if (!graph) {
    writeFailedIndexingManifests(resolvedOutputDir, indexingManifest)
    throw missingCodeExtractionError(detected.total_files, discoverySafety)
  }

  if (!options.clusterOnly && graph.numberOfNodes() === 0) {
    writeFailedIndexingManifests(resolvedOutputDir, indexingManifest)
    throw missingCodeExtractionError(detected.total_files, discoverySafety)
  }

  graph.graph.indexing_completeness = graphIndexingMetadata(indexingManifest)
  graph.graph.extraction_receipt = {
    requested_mode: extractionMode,
    strategies: indexingManifest.summary.extraction_strategy_buckets ?? {},
    fallbacks: indexingManifest.summary.fallback_reason_buckets ?? {},
  }
  const effectiveIndexingStrict = options.indexingStrict ?? storedClusterOptions?.indexingStrict
  if (effectiveIndexingStrict) {
    const violations = indexingStrictViolations(indexingManifest.summary, effectiveIndexingStrict)
    if (violations.length > 0) {
      const failedArtifacts = writeFailedIndexingManifests(resolvedOutputDir, indexingManifest)
      throw new IndexingCompletenessError(failedArtifacts.manifestPath, indexingManifest.summary, violations)
    }
  }

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
  const report = generateReport(
    graph,
    communities,
    cohesionScores,
    communityLabels,
    godNodeList,
    surpriseList,
    semanticAnomalyList,
    detectionSummary(detected, indexingManifest.summary),
    { input: 0, output: 0 },
    resolvedRootPath,
    suggestedQuestions,
  )

  graph.graph.discovery_safety = discoverySafety
  graph.graph.generation_policy = generationPolicyToPublish
  // Cluster-only mode reuses the existing graph; it must not relabel that
  // graph based on the currently discovered corpus without re-extracting it.
  const graphUsesSpi = options.clusterOnly
    ? existingGraph?.graph.spi_mode === true
    : spiProducedEvidence
  if (graphUsesSpi) {
    graph.graph.spi_mode = true
  } else {
    delete graph.graph.spi_mode
  }
  graph.graph.graph_build_freshness = buildGraphBuildFreshnessMetadata(
    resolvedRootPath,
    graph
      .nodeEntries()
      .map(([, attributes]) => String(attributes.source_file ?? '').trim())
      .filter((sourceFile) => sourceFile.length > 0),
  )
  graph.graph.extractor_version = EXTRACTOR_CACHE_VERSION
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

  progress?.({ step: 'export', message: 'Writing outputs...' })
  writeTextFileAtomically(reportPath, `${report}\n`)
  writeGraphArtifact(graph, graphPath)
  if (wikiPath) {
    const articleCount = toWiki(graph, communities, wikiPath, {
      communityLabels,
      cohesion: cohesionScores,
      godNodes: godNodeList,
    })
    notes.push(`Generated ${articleCount} wiki article(s).`)
  }
  let docsPath: string | null = null
  if (options.docs) {
    const docsResult = generateDocsArtifacts(graph, communities, communityLabels, resolvedOutputDir)
    docsPath = docsResult.docsPath
    notes.push(`${docsResult.fileCount} module doc(s) generated in ${docsPath}.`)
  }

  // Advance incremental fingerprints only after every graph artifact succeeds.
  // The indexing audit manifests intentionally remain available on failed runs.
  const indexingArtifacts = writeIndexingManifests(resolvedOutputDir, indexingManifest)
  writeManifestSnapshot(sourceManifestSnapshot, manifestPath)
  for (const name of ['graph.html', 'graph-pages', 'graph.svg', 'graph.graphml', 'cypher.txt', 'obsidian']) rmSync(join(resolvedOutputDir, name), { recursive: true, force: true })

  return {
    mode,
    extractionMode,
    rootPath: resolvedRootPath,
    outputDir: resolvedOutputDir,
    graphPath,
    reportPath,
    wikiPath,
    docsPath,
    totalFiles: detected.total_files,
    codeFiles: codeFiles.length,
    nonCodeFiles,
    extractableFiles: extractableFiles.length,
    extractedFiles,
    totalWords: detected.total_words,
    nodeCount: graph.numberOfNodes(),
    edgeCount: graph.numberOfEdges(),
    communityCount: Object.keys(communities).length,
    semanticAnomalyCount: semanticAnomalyList.length,
    changedFiles,
    deletedFiles,
    cache: cacheSummary,
    warning: detected.warning,
    notes,
    discoverySafety,
    discoveryExclusions: discoverySafety.exclusions,
    indexingManifestPath: indexingArtifacts.manifestPath,
    indexingShareSafeManifestPath: indexingArtifacts.shareSafeManifestPath,
    indexing: indexingManifest.summary,
  }
}
