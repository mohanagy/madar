import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import type { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { classifyFile } from '../pipeline/detect.js'
import type { RetrieveResult } from './retrieve.js'
import {
  fileContentFingerprint,
  isGraphBuildFreshnessMetadata,
  normalizeFreshnessSourceFile,
  type GraphBuildFreshnessMetadata,
} from '../shared/graph-build-freshness.js'
import { diffGitFilesBetweenCommits, readGitSnapshot } from '../shared/git.js'
import { readPackageVersion } from '../shared/package-metadata.js'
import { validateGraphPath } from '../shared/security.js'
import { isDiscoveryPathIgnored, loadMadarignorePatterns } from '../shared/source-discovery.js'

export interface GraphFreshnessMetadata {
  graphVersion: string
  graphModifiedMs: number
  graphModifiedAt: string
}

export interface ResourceFreshnessMetadata extends GraphFreshnessMetadata {
  resourceBytes: number
  resourceModifiedMs: number
  resourceModifiedAt: string
  etag: string
}

export type GraphContextFreshnessStatus = 'fresh' | 'partially_stale' | 'possibly_stale' | 'stale' | 'missing'
export type SelectedContextFreshnessStatus = 'fresh' | 'possibly_stale' | 'stale' | 'unknown'

export interface GraphContextFreshnessSelection {
  selected_source_files?: readonly string[]
}

export interface GraphContextFreshness {
  status: GraphContextFreshnessStatus
  graph_path: string
  graph_version: string | null
  graph_modified_ms: number | null
  graph_modified_at: string | null
  generated_ms: number | null
  generated_at: string | null
  madar_version: string
  indexed_file_count: number
  changed_source_count: number
  missing_source_count: number
  selected_context_status: SelectedContextFreshnessStatus
  selected_context_file_count: number
  changed_selected_context_count: number
  missing_selected_context_count: number
  changed_outside_selected_context_count: number
  recommendation: string
}

interface IndexedSourceFiles {
  rootPath: string
  sourceFiles: string[]
  buildFreshness: GraphBuildFreshnessMetadata | null
}

const VERSION_HASH_LENGTH = 12
const graphVersionCache = new Map<string, { graphVersion: string; mtimeMs: number; size: number }>()
// Agent instruction files are execution guidance, not repository source
// evidence. Madar's installers deliberately add or update these files after a
// graph exists; letting that invalidate the graph forces a large auto-refresh
// before the first MCP request can answer.
const AGENT_INSTRUCTION_FILES = new Set(['AGENTS.md', 'CLAUDE.md'])

function isAgentInstructionFile(sourceFile: string): boolean {
  return AGENT_INSTRUCTION_FILES.has(sourceFile.replaceAll('\\', '/'))
}

function truncateMtime(mtimeMs: number): number {
  return Math.trunc(mtimeMs)
}

function freshnessRecommendation(
  status: GraphContextFreshnessStatus,
  selectedContextStatus: SelectedContextFreshnessStatus,
): string {
  switch (status) {
    case 'fresh':
      return 'Graph is fresh enough to rely on.'
    case 'partially_stale':
      return selectedContextStatus === 'fresh'
        ? 'Selected context is still fresh. Proceeding is allowed, but run `madar generate .` when you need whole-repo freshness.'
        : 'Some indexed files changed after graph generation. Run `madar generate .` or keep `madar watch .` running, then re-check with `madar doctor` or `madar status`.'
    case 'possibly_stale':
      return 'Run `madar generate .` or keep `madar watch .` running, then re-check with `madar doctor` or `madar status`.'
    case 'stale':
      return 'Run `madar generate .` to rebuild the graph, then confirm freshness with `madar doctor` or `madar status`.'
    case 'missing':
      return 'Run `madar generate .` to create a graph, then confirm freshness with `madar doctor` or `madar status`.'
  }
}

export function graphFreshnessStatusLabel(status: GraphContextFreshnessStatus): string {
  switch (status) {
    case 'partially_stale':
      return 'partially stale'
    case 'possibly_stale':
      return 'possibly stale'
    default:
      return status
  }
}

function missingGraphContextFreshness(graphPath: string): GraphContextFreshness {
  return {
    status: 'missing',
    graph_path: graphPath,
    graph_version: null,
    graph_modified_ms: null,
    graph_modified_at: null,
    generated_ms: null,
    generated_at: null,
    madar_version: readPackageVersion(),
    indexed_file_count: 0,
    changed_source_count: 0,
    missing_source_count: 0,
    selected_context_status: 'unknown',
    selected_context_file_count: 0,
    changed_selected_context_count: 0,
    missing_selected_context_count: 0,
    changed_outside_selected_context_count: 0,
    recommendation: freshnessRecommendation('missing', 'unknown'),
  }
}

function normalizedSourceFileSet(rootPath: string, sourceFiles: readonly string[] | undefined): Set<string> {
  return new Set(
    (sourceFiles ?? [])
      .map((sourceFile) => normalizeFreshnessSourceFile(rootPath, sourceFile))
      .filter((sourceFile) => sourceFile.length > 0),
  )
}

function addExecutionStepFiles(
  sourceFiles: Set<string>,
  steps: ReadonlyArray<{ source_file: string }> | undefined,
): void {
  for (const step of steps ?? []) {
    const sourceFile = typeof step.source_file === 'string' ? step.source_file.trim() : ''
    if (sourceFile.length > 0) {
      sourceFiles.add(sourceFile)
    }
  }
}

export function selectedContextSourceFilesFromRetrieveResult(
  result: Pick<RetrieveResult, 'matched_nodes' | 'execution_slice' | 'slice'>,
): string[] {
  const sourceFiles = new Set<string>()
  const matchedById = new Map(
    result.matched_nodes
      .filter((node) => typeof node.node_id === 'string' && node.node_id.length > 0)
      .map((node) => [node.node_id as string, node]),
  )
  const matchedByLabel = new Map(
    result.matched_nodes.map((node) => [node.label, node]),
  )

  for (const anchor of result.slice?.anchors ?? []) {
    const node = typeof anchor.node_id === 'string' ? matchedById.get(anchor.node_id) : matchedByLabel.get(anchor.label)
    const sourceFile = node?.source_file?.trim() ?? ''
    if (sourceFile.length > 0) {
      sourceFiles.add(sourceFile)
    }
  }

  addExecutionStepFiles(sourceFiles, result.execution_slice?.steps)
  addExecutionStepFiles(sourceFiles, result.execution_slice?.primary_path?.steps)
  for (const branch of result.execution_slice?.side_effects ?? []) {
    addExecutionStepFiles(sourceFiles, branch.steps)
  }
  for (const branch of result.execution_slice?.terminal_boundaries ?? []) {
    addExecutionStepFiles(sourceFiles, branch.steps)
  }

  for (const path of result.slice?.selected_paths ?? []) {
    const fromNode = typeof path.from_id === 'string' ? matchedById.get(path.from_id) : matchedByLabel.get(path.from)
    const toNode = typeof path.to_id === 'string' ? matchedById.get(path.to_id) : matchedByLabel.get(path.to)
    for (const node of [fromNode, toNode]) {
      const sourceFile = node?.source_file?.trim() ?? ''
      if (sourceFile.length > 0) {
        sourceFiles.add(sourceFile)
      }
    }
  }

  if (sourceFiles.size === 0) {
    const directNodes = result.matched_nodes.filter((node) => node.relevance_band === 'direct')
    const scoredNodes = result.matched_nodes.filter((node) => node.match_score > 0 && node.relevance_band !== 'peripheral')
    const fallbackNodes = directNodes.length > 0
      ? directNodes
      : scoredNodes.length > 0
        ? scoredNodes
        : result.matched_nodes.filter((node) => node.relevance_band !== 'peripheral')
    for (const node of (fallbackNodes.length > 0 ? fallbackNodes : result.matched_nodes)) {
      const sourceFile = node?.source_file?.trim() ?? ''
      if (sourceFile.length > 0) {
        sourceFiles.add(sourceFile)
      }
    }
  }

  return [...sourceFiles]
}

function graphSourceRoot(graphPath: string, graph?: Pick<KnowledgeGraph, 'graph'>): string {
  const rootPath = typeof graph?.graph.root_path === 'string' && graph.graph.root_path.trim().length > 0
    ? graph.graph.root_path.trim()
    : ''
  return rootPath.length > 0 ? rootPath : dirname(graphPath)
}

function graphBuildFreshnessFromValue(value: unknown): GraphBuildFreshnessMetadata | null {
  return isGraphBuildFreshnessMetadata(value) ? value : null
}

function indexedSourceFilesFromGraph(
  graph: Pick<KnowledgeGraph, 'graph' | 'nodeEntries'>,
  graphPath: string,
): IndexedSourceFiles {
  const rootPath = graphSourceRoot(graphPath, graph)
  const sourceFiles = [...new Set(
    graph.nodeEntries()
      .map(([, attributes]) => normalizeFreshnessSourceFile(rootPath, String(attributes.source_file ?? '').trim()))
      .filter((sourceFile) => sourceFile.length > 0),
  )]

  return {
    rootPath,
    sourceFiles,
    buildFreshness: graphBuildFreshnessFromValue(graph.graph.graph_build_freshness),
  }
}

function indexedSourceFilesFromGraphJson(graphPath: string): IndexedSourceFiles {
  return indexedSourceFilesFromGraph(loadGraphArtifact(graphPath), graphPath)
}

function resolveIndexedSourcePath(rootPath: string, sourceFile: string): string {
  return isAbsolute(sourceFile) ? sourceFile : resolve(rootPath, sourceFile)
}

function collectMissingSourceFiles(indexed: IndexedSourceFiles): Set<string> {
  const missingSourceFiles = new Set<string>()
  for (const sourceFile of indexed.sourceFiles) {
    if (isAgentInstructionFile(sourceFile)) {
      continue
    }
    if (!existsSync(resolveIndexedSourcePath(indexed.rootPath, sourceFile))) {
      missingSourceFiles.add(sourceFile)
    }
  }
  return missingSourceFiles
}

function legacyChangedSourceFiles(
  indexed: IndexedSourceFiles,
  graphModifiedMs: number,
): Set<string> {
  const changedSourceFiles = new Set<string>()
  for (const sourceFile of indexed.sourceFiles) {
    if (isAgentInstructionFile(sourceFile)) {
      continue
    }
    const resolvedSourcePath = resolveIndexedSourcePath(indexed.rootPath, sourceFile)
    try {
      const sourceModifiedMs = truncateMtime(statSync(resolvedSourcePath).mtimeMs)
      if (sourceModifiedMs > graphModifiedMs) {
        changedSourceFiles.add(sourceFile)
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue
      }
      throw error
    }
  }
  return changedSourceFiles
}

function filesystemChangedSourceFiles(
  indexed: IndexedSourceFiles,
  buildFreshness: GraphBuildFreshnessMetadata,
): Set<string> {
  const storedFingerprints = buildFreshness.filesystem?.file_fingerprints ?? {}
  const changedSourceFiles = new Set<string>()

  for (const sourceFile of indexed.sourceFiles) {
    if (isAgentInstructionFile(sourceFile)) {
      continue
    }
    const resolvedSourcePath = resolveIndexedSourcePath(indexed.rootPath, sourceFile)
    if (!existsSync(resolvedSourcePath)) {
      continue
    }
    const currentFingerprint = fileContentFingerprint(resolvedSourcePath)
    if (storedFingerprints[sourceFile] !== currentFingerprint) {
      changedSourceFiles.add(sourceFile)
    }
  }

  return changedSourceFiles
}

function graphRelevantGitChangedFiles(
  indexed: IndexedSourceFiles,
  changedFiles: readonly string[],
): Set<string> {
  const indexedSourceFiles = new Set(indexed.sourceFiles)
  const ignorePatterns = loadMadarignorePatterns(indexed.rootPath)
  const relevantFiles = new Set<string>()

  for (const rawPath of changedFiles) {
    const sourceFile = normalizeFreshnessSourceFile(indexed.rootPath, rawPath)
    if (sourceFile.length === 0) {
      continue
    }
    if (isAgentInstructionFile(sourceFile)) {
      continue
    }
    if (indexedSourceFiles.has(sourceFile)) {
      relevantFiles.add(sourceFile)
      continue
    }

    const resolvedSourcePath = resolveIndexedSourcePath(indexed.rootPath, sourceFile)
    if (!existsSync(resolvedSourcePath)) {
      continue
    }
    if (isDiscoveryPathIgnored(resolvedSourcePath, indexed.rootPath, ignorePatterns)) {
      continue
    }
    if (classifyFile(resolvedSourcePath) !== null) {
      relevantFiles.add(sourceFile)
    }
  }

  return relevantFiles
}

function gitChangedSourceFiles(
  indexed: IndexedSourceFiles,
  buildFreshness: GraphBuildFreshnessMetadata,
): Set<string> | null {
  const currentSnapshot = readGitSnapshot(indexed.rootPath)
  const storedGitFreshness = buildFreshness.git
  if (!currentSnapshot || !storedGitFreshness) {
    return null
  }

  const changedFiles = new Set<string>(
    diffGitFilesBetweenCommits(indexed.rootPath, storedGitFreshness.head_sha, currentSnapshot.headSha),
  )
  const buildDirtyFiles = new Set(storedGitFreshness.dirty_files)
  const currentDirtyFiles = new Set(currentSnapshot.dirtyFiles)

  for (const sourceFile of buildDirtyFiles) {
    if (!currentDirtyFiles.has(sourceFile)) {
      changedFiles.add(sourceFile)
    }
  }
  for (const sourceFile of currentDirtyFiles) {
    if (!buildDirtyFiles.has(sourceFile)) {
      changedFiles.add(sourceFile)
    }
  }

  for (const sourceFile of buildDirtyFiles) {
    if (!currentDirtyFiles.has(sourceFile)) {
      continue
    }
    const resolvedSourcePath = resolveIndexedSourcePath(indexed.rootPath, sourceFile)
    const storedFingerprint = storedGitFreshness.dirty_file_fingerprints[sourceFile]
    if (!existsSync(resolvedSourcePath) || storedFingerprint === undefined) {
      changedFiles.add(sourceFile)
      continue
    }
    if (fileContentFingerprint(resolvedSourcePath) !== storedFingerprint) {
      changedFiles.add(sourceFile)
    }
  }

  return graphRelevantGitChangedFiles(indexed, [...changedFiles])
}

function graphVersionForPath(graphPath: string): { graphVersion: string; mtimeMs: number } {
  const safeGraphPath = validateGraphPath(graphPath)
  const graphStat = statSync(safeGraphPath)
  const truncatedMtime = truncateMtime(graphStat.mtimeMs)
  const cached = graphVersionCache.get(safeGraphPath)

  if (cached && cached.mtimeMs === truncatedMtime && cached.size === graphStat.size) {
    return {
      graphVersion: cached.graphVersion,
      mtimeMs: truncatedMtime,
    }
  }

  // Validate the canonical artifact before publishing freshness metadata. A
  // legacy or corrupt graph must not look fresh merely because its bytes are
  // stable.
  loadGraphArtifact(safeGraphPath)
  const graphVersion = createHash('sha256').update(readFileSync(safeGraphPath)).digest('hex').slice(0, VERSION_HASH_LENGTH)
  graphVersionCache.set(safeGraphPath, {
    graphVersion,
    mtimeMs: truncatedMtime,
    size: graphStat.size,
  })

  return {
    graphVersion,
    mtimeMs: truncatedMtime,
  }
}

export function graphFreshnessMetadata(graphPath: string): GraphFreshnessMetadata {
  const { graphVersion, mtimeMs } = graphVersionForPath(graphPath)

  return {
    graphVersion,
    graphModifiedMs: mtimeMs,
    graphModifiedAt: new Date(mtimeMs).toUTCString(),
  }
}

export function analyzeGraphContextFreshness(
  graphPath: string,
  graph?: Pick<KnowledgeGraph, 'graph' | 'nodeEntries'>,
  selection?: GraphContextFreshnessSelection,
): GraphContextFreshness {
  let safeGraphPath: string
  try {
    safeGraphPath = validateGraphPath(graphPath)
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message.startsWith('Graph file not found:')
        || error.message.startsWith('Graph base directory does not exist:')
      )
    ) {
      return missingGraphContextFreshness(graphPath)
    }
    throw error
  }

  const graphFreshness = graphFreshnessMetadata(safeGraphPath)
  const indexed = graph
    ? indexedSourceFilesFromGraph(graph, safeGraphPath)
    : indexedSourceFilesFromGraphJson(safeGraphPath)
  const indexedSourceFileSet = new Set(indexed.sourceFiles)
  const selectionProvided = selection?.selected_source_files !== undefined
  const selectedSourceFiles = normalizedSourceFileSet(indexed.rootPath, selection?.selected_source_files)
  const selectedIndexedSourceFiles = [...selectedSourceFiles].filter((sourceFile) => indexedSourceFileSet.has(sourceFile))
  const missingSourceFiles = collectMissingSourceFiles(indexed)
  const changedSourceFiles =
    indexed.buildFreshness?.strategy === 'git'
      ? gitChangedSourceFiles(indexed, indexed.buildFreshness) ?? legacyChangedSourceFiles(indexed, graphFreshness.graphModifiedMs)
      : indexed.buildFreshness?.strategy === 'filesystem'
        ? filesystemChangedSourceFiles(indexed, indexed.buildFreshness)
        : legacyChangedSourceFiles(indexed, graphFreshness.graphModifiedMs)
  const changedSourceCount = changedSourceFiles.size
  const missingSourceCount = missingSourceFiles.size

  const changedSelectedContextCount = selectedIndexedSourceFiles.filter((sourceFile) => changedSourceFiles.has(sourceFile)).length
  const missingSelectedContextCount = selectedIndexedSourceFiles.filter((sourceFile) => missingSourceFiles.has(sourceFile)).length
  const selectedContextStatus: SelectedContextFreshnessStatus = !selectionProvided
    ? 'unknown'
    : selectedIndexedSourceFiles.length === 0
      ? 'unknown'
      : missingSelectedContextCount > 0
        ? 'stale'
        : changedSelectedContextCount > 0
          ? 'possibly_stale'
          : 'fresh'
  const status: GraphContextFreshnessStatus = missingSourceCount > 0
    ? 'stale'
    : changedSourceCount > 0
      ? !selectionProvided || selectedContextStatus === 'fresh'
        ? 'partially_stale'
        : 'possibly_stale'
      : 'fresh'

  return {
    status,
    graph_path: safeGraphPath,
    graph_version: graphFreshness.graphVersion,
    graph_modified_ms: graphFreshness.graphModifiedMs,
    graph_modified_at: graphFreshness.graphModifiedAt,
    generated_ms: indexed.buildFreshness?.generated_ms ?? graphFreshness.graphModifiedMs,
    generated_at: indexed.buildFreshness?.generated_at ?? new Date(graphFreshness.graphModifiedMs).toISOString(),
    madar_version: readPackageVersion(),
    indexed_file_count: indexed.sourceFiles.length,
    changed_source_count: changedSourceCount,
    missing_source_count: missingSourceCount,
    selected_context_status: selectedContextStatus,
    selected_context_file_count: selectedIndexedSourceFiles.length,
    changed_selected_context_count: changedSelectedContextCount,
    missing_selected_context_count: missingSelectedContextCount,
    changed_outside_selected_context_count: Math.max(0, changedSourceCount - changedSelectedContextCount),
    recommendation: freshnessRecommendation(status, selectedContextStatus),
  }
}

export function requireFreshGraph(
  freshness: Pick<GraphContextFreshness, 'status' | 'recommendation'>,
  optionName = '--require-fresh-graph',
): void {
  if (freshness.status === 'fresh') {
    return
  }

  throw new Error(`${optionName} requires a fresh graph, but graph freshness is ${freshness.status}. ${freshness.recommendation}`)
}

export function requireFreshSelectedContext(
  freshness: Pick<GraphContextFreshness, 'selected_context_status' | 'recommendation'>,
  optionName = '--require-fresh-context',
): void {
  if (freshness.selected_context_status === 'fresh') {
    return
  }

  throw new Error(
    `${optionName} requires fresh selected context, but selected context freshness is ${freshness.selected_context_status}. ${freshness.recommendation}`,
  )
}

export function resourceFreshnessMetadata(graphPath: string, resourcePath: string, validatedGraphContent?: string, validatedGraphHash?: string): ResourceFreshnessMetadata {
  const resourceStat = statSync(resourcePath)
  const resourceModifiedMs = truncateMtime(resourceStat.mtimeMs)
  const resourceName = basename(resourcePath)
  const graphFreshness = validatedGraphContent === undefined
    ? graphFreshnessMetadata(graphPath)
    : { graphVersion: (validatedGraphHash ?? createHash('sha256').update(validatedGraphContent).digest('hex')).slice(0, VERSION_HASH_LENGTH), graphModifiedMs: resourceModifiedMs, graphModifiedAt: new Date(resourceModifiedMs).toUTCString() }
  const resourceBytes = validatedGraphContent === undefined ? resourceStat.size : Buffer.byteLength(validatedGraphContent)

  return {
    ...graphFreshness,
    resourceBytes,
    resourceModifiedMs,
    resourceModifiedAt: new Date(resourceModifiedMs).toUTCString(),
    etag: `W/"madar-${graphFreshness.graphVersion}-${resourceName}-${resourceBytes}-${resourceModifiedMs}"`,
  }
}

export function freshnessAnnotations(metadata: ResourceFreshnessMetadata): Record<string, number | string> {
  return {
    graph_version: metadata.graphVersion,
    graph_modified_ms: metadata.graphModifiedMs,
    graph_modified_at: metadata.graphModifiedAt,
    resource_bytes: metadata.resourceBytes,
    resource_modified_ms: metadata.resourceModifiedMs,
    resource_modified_at: metadata.resourceModifiedAt,
    resource_etag: metadata.etag,
  }
}

export function graphFreshnessHeaders(metadata: GraphFreshnessMetadata): Record<string, string> {
  return {
    'x-madar-graph-version': metadata.graphVersion,
    'x-madar-graph-modified-ms': String(metadata.graphModifiedMs),
    'x-madar-graph-modified-at': metadata.graphModifiedAt,
  }
}

export function resourceFreshnessHeaders(metadata: ResourceFreshnessMetadata): Record<string, string> {
  return {
    ...graphFreshnessHeaders(metadata),
    etag: metadata.etag,
    'last-modified': metadata.resourceModifiedAt,
    'x-madar-resource-bytes': String(metadata.resourceBytes),
    'x-madar-resource-modified-ms': String(metadata.resourceModifiedMs),
    'x-madar-resource-modified-at': metadata.resourceModifiedAt,
  }
}
