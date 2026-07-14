import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import type { ExtractionData, ExtractionEdge, ExtractionNode, ExtractionSchemaVersion, Hyperedge } from '../contracts/types.js'
import { godNodes, semanticAnomalies, suggestQuestions, surprisingConnections } from '../pipeline/analyze.js'
import { buildFromJson } from '../pipeline/build.js'
import { cluster, scoreAll } from '../pipeline/cluster.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { type DetectResult, detect, detectIncremental, FileType, saveManifest } from '../pipeline/detect.js'
import { generateDocs as generateDocsArtifacts } from '../pipeline/docs.js'
import { toCypher, toGraphml, toHtml, toJson, toObsidian, toSvg } from '../pipeline/export.js'
import { extract, EXTRACTOR_CACHE_VERSION } from '../pipeline/extract.js'
import { buildSpiCached, type SpiCacheStats } from '../pipeline/spi/cache.js'
import { projectSpiToExtraction } from '../pipeline/spi/projector.js'
import { generate as generateReport } from '../pipeline/report.js'
import { toWiki } from '../pipeline/wiki.js'
import { loadGraph } from '../runtime/serve.js'
import { buildGraphBuildFreshnessMetadata } from '../shared/graph-build-freshness.js'
import { collectGitVisibleFiles } from '../shared/git.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'
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
  /** Generated code graphs are directed by default. Set false only for visualization-only legacy output. */
  directed?: boolean
  followSymlinks?: boolean
  /** Restrict discovery to files that Git does not ignore. Falls back outside Git repositories. */
  respectGitignore?: boolean
  noHtml?: boolean
  htmlMode?: 'auto' | 'inline' | 'overview'
  wiki?: boolean
  obsidian?: boolean
  obsidianDir?: string | null
  svg?: boolean
  graphml?: boolean
  neo4j?: boolean
  includeDocs?: boolean
  docs?: boolean
  /** v0.18 — opt-in: use the SPI v1 pipeline (buildSpiCached +
   *  projectSpiToExtraction) instead of the legacy extract() call site.
   *  When true, framework_role + framework_metadata flow into graph.json
   *  for all 9 framework substrates (NestJS, Express, Next.js, React
   *  Router, Redux, Hono, Fastify, tRPC, Prisma) and repeat builds on an
   *  unchanged workspace hit the on-disk SPI cache. Default false. */
  useSpi?: boolean
  onProgress?: (progress: ProgressStep) => void
}

export interface GenerateGraphResult {
  mode: 'generate' | 'update' | 'cluster-only'
  rootPath: string
  outputDir: string
  graphPath: string
  reportPath: string
  htmlPath: string | null
  wikiPath: string | null
  obsidianPath: string | null
  svgPath: string | null
  graphmlPath: string | null
  cypherPath: string | null
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

function detectionSummary(detection: DetectResult): Record<string, unknown> {
  const discoverySafety = buildDiscoverySafetyMetadata(detection.exclusions)
  return {
    files: detection.files,
    total_files: detection.total_files,
    total_words: detection.total_words,
    warning: detection.warning,
    discovery_safety: discoverySafety.summary,
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

function copyGraphWithDirection(graph: KnowledgeGraph, directed: boolean): KnowledgeGraph {
  const copied = new KnowledgeGraph({ directed })
  Object.assign(copied.graph, graph.graph, { directed })

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    copied.addNode(nodeId, attributes)
  }
  for (const [source, target, attributes] of graph.edgeEntries()) {
    copied.addEdge(source, target, attributes)
  }

  return copied
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
  try {
    const parsed = JSON.parse(readFileSync(graphPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }

    const extractorVersion = (parsed as { extractor_version?: unknown }).extractor_version
    return typeof extractorVersion === 'number' && Number.isFinite(extractorVersion) ? extractorVersion : null
  } catch {
    return null
  }
}

export function generateGraph(rootPath = '.', options: GenerateGraphOptions = {}): GenerateGraphResult {
  if (options.update && options.clusterOnly) {
    throw new Error('--update and --cluster-only cannot be used together')
  }

  const resolvedRootPath = resolve(rootPath)
  const resolvedOutputDir = outputDirectory(resolvedRootPath)
  const graphPath = join(resolvedOutputDir, 'graph.json')
  const reportPath = join(resolvedOutputDir, 'GRAPH_REPORT.md')
  const htmlPath = join(resolvedOutputDir, 'graph.html')
  const wikiPath = options.wiki ? join(resolvedOutputDir, 'wiki') : null
  const obsidianPath = options.obsidian ? resolve(options.obsidianDir ?? join(resolvedOutputDir, 'obsidian')) : null
  const svgPath = options.svg ? join(resolvedOutputDir, 'graph.svg') : null
  const graphmlPath = options.graphml ? join(resolvedOutputDir, 'graph.graphml') : null
  const cypherPath = options.neo4j ? join(resolvedOutputDir, 'cypher.txt') : null
  const manifestPath = join(resolvedOutputDir, 'manifest.json')

  mkdirSync(resolvedOutputDir, { recursive: true })
  const progress = options.onProgress

  progress?.({ step: 'detect', message: 'Scanning files...' })
  const gitVisibleFiles = options.respectGitignore ? collectGitVisibleFiles(resolvedRootPath) : null
  const detectionOptions = detectOptions(options, gitVisibleFiles)
  const detected = options.update ? detectIncremental(resolvedRootPath, manifestPath, detectionOptions) : detect(resolvedRootPath, detectionOptions)
  const discoverySafety = buildDiscoverySafetyMetadata(detected.exclusions)

  if (options.includeDocs === false) {
    detected.files[FileType.DOCUMENT] = []
    if (isIncrementalDetectResult(detected)) {
      detected.new_files[FileType.DOCUMENT] = []
      detected.unchanged_files[FileType.DOCUMENT] = []
    }
  }
  const notes: string[] = []
  const mode: GenerateGraphResult['mode'] = options.clusterOnly ? 'cluster-only' : options.update ? 'update' : 'generate'

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
  let extractedFiles = options.clusterOnly ? 0 : extractableFiles.length
  let cacheSummary: GenerateGraphCacheSummary | null = null

  progress?.({ step: 'detect', message: `Found ${detected.total_files} files (~${detected.total_words.toLocaleString()} words)` })

  const loadedExistingGraph = options.clusterOnly || (options.update && existsSync(graphPath)) ? loadGraph(graphPath) : null
  const existingGraphExtractorVersion = options.update && existsSync(graphPath) ? loadGraphExtractorVersion(graphPath) : null
  const directed = options.directed !== false
  const upgradingLegacyDirection = loadedExistingGraph?.isDirected() === false && directed

  if (options.clusterOnly && upgradingLegacyDirection) {
    throw new Error(
      '--cluster-only cannot safely recover edge directions from an undirected graph. '
      + 'Run `madar generate . --update` to re-extract the source graph with directed edges.',
    )
  }

  const existingGraph = loadedExistingGraph && loadedExistingGraph.isDirected() !== directed && !upgradingLegacyDirection
    ? copyGraphWithDirection(loadedExistingGraph, directed)
    : loadedExistingGraph

  if (upgradingLegacyDirection) {
    notes.push('Existing graph was undirected, so --update rebuilt the full graph with directed edges.')
  } else if (loadedExistingGraph && loadedExistingGraph.isDirected() !== directed) {
    notes.push(
      'Migrated the existing graph from directed to undirected edge traversal.',
    )
  }

  if (!options.clusterOnly) {
    progress?.({ step: 'extract', message: `Extracting ${extractableFiles.length} files...`, current: 0, total: extractableFiles.length })
  }

  // v0.18 — opt-in SPI pipeline. When useSpi is true, ignore the
  // incremental branch entirely: buildSpiCached handles the
  // "unchanged workspace" case at the SPI layer via its all-or-nothing
  // disk cache (#77), so we always do a full SPI build + projection.
  const buildViaSpi = (): ReturnType<typeof buildFromJson> | null => {
    if (extractableFiles.length === 0) return null
    const spiExtractorVersion = `spi-v1.0.0-enqueues-job-${EXTRACTOR_CACHE_VERSION}`
    const built =
      codeFiles.length > 0
        ? buildSpiCached({
            root: resolvedRootPath,
            madarVersion: `spi-extractor-${EXTRACTOR_CACHE_VERSION}`,
            extractorVersion: spiExtractorVersion,
            ...(gitVisibleFiles ? { includedFiles: new Set(gitVisibleFiles.map((filePath) => resolve(filePath))) } : {}),
          })
        : null
    const spiExtraction = built ? projectSpiToExtraction(built.spi, { root: resolvedRootPath }) : emptyExtraction()
    const nonCodeExtraction =
      nonCodeExtractableFiles.length > 0
        ? extract(nonCodeExtractableFiles, {
            allowedTargets: extractableFiles,
            contextNodes: spiExtraction.nodes,
          })
        : emptyExtraction()

    extractedFiles = (built ? (built.cache.hit ? 0 : built.cache.file_count) : 0) + nonCodeExtractableFiles.length
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
    return buildFromJson(mergeExtractions([spiExtraction, nonCodeExtraction]), { directed })
  }

  const graph = options.clusterOnly
    ? existingGraph
    : options.useSpi
      ? buildViaSpi()
    : options.update && existingGraph && upgradingLegacyDirection
      ? (() => {
          extractedFiles = extractableFiles.length
          return extractableFiles.length > 0 ? buildFromJson(extract(extractableFiles), { directed }) : null
        })()
    : options.update && existingGraph && isIncrementalDetectResult(detected)
        ? (() => {
            if (existingGraphExtractorVersion == null || existingGraphExtractorVersion !== EXTRACTOR_CACHE_VERSION) {
              notes.push(
                existingGraphExtractorVersion == null
                  ? 'Existing graph predates extractor version metadata, so --update rebuilt the full graph.'
                  : `Existing graph uses extractor version ${existingGraphExtractorVersion}, so --update rebuilt the full graph.`,
              )
              extractedFiles = extractableFiles.length
              return extractableFiles.length > 0 ? buildFromJson(extract(extractableFiles), { directed }) : null
            }

            const changedExtractableFiles = collectExtractableFiles(detected.new_files)
            const removedSourceFiles = new Set([...changedExtractableFiles, ...detected.deleted_files].map((filePath) => resolve(filePath)))

            if (changedExtractableFiles.length === 0 && detected.deleted_files.length === 0) {
              notes.push('No changed files detected - reused the existing graph.')
              extractedFiles = 0
              return existingGraph
            }

            const retainedExtraction = retainedExtractionFromGraph(existingGraph, removedSourceFiles)
            const changedExtraction =
              changedExtractableFiles.length > 0
                ? extract(changedExtractableFiles, {
                    allowedTargets: extractableFiles,
                    contextNodes: retainedExtraction.nodes,
                  })
                : emptyExtraction()
            extractedFiles = changedExtractableFiles.length

            notes.push(
              `Incremental update re-extracted ${changedExtractableFiles.length} changed file(s) and retained ${new Set(retainedExtraction.nodes.map((node) => node.source_file)).size} unchanged file(s) from the existing graph.`,
            )

          return buildFromJson(mergeExtractions([retainedExtraction, changedExtraction]), { directed })
        })()
      : extractableFiles.length > 0
        ? buildFromJson(extract(extractableFiles), { directed })
        : options.update && existingGraph
          ? existingGraph
          : null

  if (!graph) {
    throw missingCodeExtractionError(detected.total_files, discoverySafety)
  }

  if (!options.clusterOnly && graph.numberOfNodes() === 0) {
    throw missingCodeExtractionError(detected.total_files, discoverySafety)
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
    detectionSummary(detected),
    { input: 0, output: 0 },
    resolvedRootPath,
    suggestedQuestions,
  )

  graph.graph.root_path = resolvedRootPath
  graph.graph.discovery_safety = discoverySafety
  if (options.useSpi) {
    graph.graph.spi_mode = true
  }
  graph.graph.graph_build_freshness = buildGraphBuildFreshnessMetadata(
    resolvedRootPath,
    graph
      .nodeEntries()
      .map(([, attributes]) => String(attributes.source_file ?? '').trim())
      .filter((sourceFile) => sourceFile.length > 0),
  )

  progress?.({ step: 'export', message: 'Writing outputs...' })
  writeFileSync(reportPath, `${report}\n`, 'utf8')
  toJson(graph, communities, graphPath, communityLabels, semanticAnomalyList, EXTRACTOR_CACHE_VERSION)
  if (!options.noHtml) {
    const htmlResult = toHtml(graph, communities, htmlPath, communityLabels, {
      mode: options.htmlMode ?? 'auto',
      cohesionScores,
    })
    if (htmlResult.mode === 'overview') {
      notes.push(`Large graph mode enabled: graph.html now opens an overview page with ${htmlResult.communityPageCount} community page(s).`)
    }
  }
  if (wikiPath) {
    const articleCount = toWiki(graph, communities, wikiPath, {
      communityLabels,
      cohesion: cohesionScores,
      godNodes: godNodeList,
    })
    notes.push(`Generated ${articleCount} wiki article(s).`)
  }
  if (obsidianPath) {
    const noteCount = toObsidian(graph, communities, obsidianPath, communityLabels, cohesionScores)
    notes.push(`Generated ${noteCount} Obsidian note(s).`)
  }
  if (svgPath) {
    toSvg(graph, communities, svgPath, communityLabels)
  }
  if (graphmlPath) {
    toGraphml(graph, communities, graphmlPath)
  }
  if (cypherPath) {
    toCypher(graph, cypherPath)
  }

  let docsPath: string | null = null
  if (options.docs) {
    const docsResult = generateDocsArtifacts(graph, communities, communityLabels, resolvedOutputDir)
    docsPath = docsResult.docsPath
    notes.push(`${docsResult.fileCount} module doc(s) generated in ${docsPath}.`)
  }

  saveManifest(detected.files, manifestPath, { total_words: detected.total_words })

  return {
    mode,
    rootPath: resolvedRootPath,
    outputDir: resolvedOutputDir,
    graphPath,
    reportPath,
    htmlPath: options.noHtml ? null : htmlPath,
    wikiPath,
    obsidianPath,
    svgPath,
    graphmlPath,
    cypherPath,
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
  }
}
