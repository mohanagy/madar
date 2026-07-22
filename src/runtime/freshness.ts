import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { existsSync, realpathSync, statSync } from 'node:fs'

import { loadGraphArtifact, parseGraphArtifact, readGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { buildSourceCatalog } from '../adapters/filesystem/source-catalog.js'
import type { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { readBuildState, type IndexBuildState, type SourceSnapshotEntry } from '../domain/index/build-state.js'
import type { RetrieveResult } from './retrieve.js'
import { readPackageVersion } from '../shared/package-metadata.js'
import { validateGraphPath } from '../shared/security.js'
import { resolveMadarWorkspace } from '../shared/workspace.js'

export interface GraphFreshnessMetadata {
  graphVersion: string
  graphModifiedMs: number
  graphModifiedAt: string
}
export interface ArtifactFreshnessReceipt { graphSha256: string; graphModifiedMs: number; resourceModifiedMs?: number }

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
  current_generation_policy_fingerprint?: string
  generation_policy_error?: string
  recommendation: string
}

interface IndexedSourceFiles {
  rootPath: string
  graphPath: string
  sourceFiles: string[]
  buildState: IndexBuildState | null
}

const VERSION_HASH_LENGTH = 12
const graphVersionCache = new Map<string, { graphVersion: string; contentHash: string }>()
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
      .map((sourceFile) => normalizeSourceFile(rootPath, sourceFile))
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

function normalizeSourceFile(rootPath: string, sourceFile: string): string {
  const value = sourceFile.trim()
  if (!value) return ''
  if (!isAbsolute(value)) return value.replaceAll('\\', '/').replace(/^\.\//, '')
  const local = relative(rootPath, value)
  return local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)
    ? value.replaceAll('\\', '/')
    : local.replaceAll('\\', '/')
}

function indexedSourceFilesFromGraph(
  graph: Pick<KnowledgeGraph, 'graph' | 'nodeEntries'>,
  graphPath: string,
): IndexedSourceFiles {
  const buildState = readBuildState(graph as KnowledgeGraph)
  const rootPath = buildState?.source_root.root_path ?? graphSourceRoot(graphPath, graph)
  const sourceFiles = buildState?.sources.supported.map((entry) => entry.path) ?? [...new Set(
    graph.nodeEntries().map(([, attributes]) => normalizeSourceFile(rootPath, String(attributes.source_file ?? '').trim()))
      .filter((sourceFile) => sourceFile.length > 0),
  )]

  return {
    rootPath,
    graphPath,
    sourceFiles,
    buildState,
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
    if (!existsSync(resolveIndexedSourcePath(indexed.rootPath, sourceFile))) {
      missingSourceFiles.add(sourceFile)
    }
  }
  return missingSourceFiles
}

const allRelevantIndexedSourceFiles = (indexed: IndexedSourceFiles): Set<string> => new Set(indexed.sourceFiles)

function canonicalPath(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

function compareEntries(
  changed: Set<string>,
  stored: readonly SourceSnapshotEntry[],
  current: readonly SourceSnapshotEntry[],
): void {
  const before = new Map(stored.map((entry) => [entry.path, entry.hash]))
  const after = new Map(current.map((entry) => [entry.path, entry.hash]))
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) !== after.get(path)) changed.add(path)
  }
}

type CatalogComparison = [changed: Set<string>, currentPolicy: string | null, error: string | null]

function catalogChangedSourceFiles(indexed: IndexedSourceFiles): CatalogComparison {
  const state = indexed.buildState
  if (!state) return [allRelevantIndexedSourceFiles(indexed), null, 'authoritative build state is unavailable']
  try {
    if (basename(dirname(indexed.graphPath)) === 'out'
      && canonicalPath(resolveMadarWorkspace(state.source_root.root_path).graphPath)
        !== canonicalPath(indexed.graphPath)) {
      return [new Set([...indexed.sourceFiles, '.madar-source-root']), null, 'graph belongs to a different source workspace']
    }
    const current = buildSourceCatalog(indexed.rootPath, {
      followSymlinks: state.policy.settings.follow_symlinks,
      respectGitignore: state.policy.settings.respect_gitignore,
      ...(state.policy.settings.indexing_strict ? {
        indexingStrict: {
          maxFailed: state.policy.settings.indexing_strict.max_failed,
          maxUnsupported: state.policy.settings.indexing_strict.max_unsupported,
        },
      } : {}),
    })
    const changed = new Set<string>()
    const changedControls = new Set<string>()
    compareEntries(changedControls, state.sources.controls, current.snapshot.controls)
    compareEntries(changed, state.sources.supported, current.snapshot.supported)
    for (const path of changedControls) changed.add(path)
    compareEntries(changed, state.sources.unsupported, current.snapshot.unsupported)
    compareEntries(changed, state.sources.inventory, current.snapshot.inventory)
    const policyChanged = state.policy.fingerprint !== current.policy.fingerprint
    if (changedControls.size > 0 || policyChanged) {
      // Compiler, discovery, and generation-policy controls can change the
      // meaning of every indexed source without changing its bytes. Retain
      // the causal control receipt and mark all supported sources affected so
      // scoped freshness cannot incorrectly report a selected file as fresh.
      for (const entry of state.sources.supported) changed.add(entry.path)
    }
    if (changedControls.size === 0 && policyChanged) {
      changed.add('.madar-policy')
    }
    return [changed, current.policy.fingerprint, null]
  } catch (error) {
    return [allRelevantIndexedSourceFiles(indexed), null, error instanceof Error ? error.message : String(error)]
  }
}

function graphVersionForPath(graphPath: string): { graphVersion: string; mtimeMs: number } {
  const safeGraphPath = validateGraphPath(graphPath)
  const graphStat = statSync(safeGraphPath)
  const truncatedMtime = truncateMtime(graphStat.mtimeMs)
  const artifact = readGraphArtifact(safeGraphPath)
  const contentHash = createHash('sha256').update(artifact).digest('hex')
  const cached = graphVersionCache.get(safeGraphPath)

  if (cached?.contentHash === contentHash) return { graphVersion: cached.graphVersion, mtimeMs: truncatedMtime }

  parseGraphArtifact(artifact)
  const graphVersion = contentHash.slice(0, VERSION_HASH_LENGTH)
  graphVersionCache.set(safeGraphPath, { graphVersion, contentHash })

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

export function graphFreshnessFromReceipt(receipt: ArtifactFreshnessReceipt): GraphFreshnessMetadata {
  return {
    graphVersion: receipt.graphSha256.slice(0, VERSION_HASH_LENGTH),
    graphModifiedMs: receipt.graphModifiedMs,
    graphModifiedAt: new Date(receipt.graphModifiedMs).toUTCString(),
  }
}

export function analyzeGraphContextFreshness(
  graphPath: string,
  graph?: Pick<KnowledgeGraph, 'graph' | 'nodeEntries'>,
  selection?: GraphContextFreshnessSelection,
  knownFreshness?: GraphFreshnessMetadata,
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

  const graphFreshness = knownFreshness ?? graphFreshnessMetadata(safeGraphPath)
  const indexed = graph
    ? indexedSourceFilesFromGraph(graph, safeGraphPath)
    : indexedSourceFilesFromGraphJson(safeGraphPath)
  const indexedSourceFileSet = new Set(indexed.sourceFiles)
  const selectionProvided = selection?.selected_source_files !== undefined
  const selectedSourceFiles = normalizedSourceFileSet(indexed.rootPath, selection?.selected_source_files)
  const selectedIndexedSourceFiles = [...selectedSourceFiles].filter((sourceFile) => indexedSourceFileSet.has(sourceFile))
  const missingSourceFiles = collectMissingSourceFiles(indexed)
  const [changedSourceFiles, currentPolicyFingerprint, policyError] = catalogChangedSourceFiles(indexed)
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
    generated_ms: graphFreshness.graphModifiedMs,
    generated_at: new Date(graphFreshness.graphModifiedMs).toISOString(),
    madar_version: readPackageVersion(),
    indexed_file_count: indexed.sourceFiles.length,
    changed_source_count: changedSourceCount,
    missing_source_count: missingSourceCount,
    selected_context_status: selectedContextStatus,
    selected_context_file_count: selectedIndexedSourceFiles.length,
    changed_selected_context_count: changedSelectedContextCount,
    missing_selected_context_count: missingSelectedContextCount,
    changed_outside_selected_context_count: Math.max(0, changedSourceCount - changedSelectedContextCount),
    ...(currentPolicyFingerprint ? { current_generation_policy_fingerprint: currentPolicyFingerprint } : {}),
    ...(policyError ? { generation_policy_error: policyError } : {}),
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

export function resourceFreshnessMetadata(graphPath: string, resourcePath: string, resourceContent?: string,
  validatedGraphHash?: string, receipt?: ArtifactFreshnessReceipt): ResourceFreshnessMetadata {
  if (resourceContent !== undefined && resourcePath !== graphPath && !validatedGraphHash) throw new Error('Non-graph resource metadata requires an authenticated graph hash')
  const exactResourceModifiedMs = receipt?.resourceModifiedMs
    ?? (resourcePath === graphPath ? receipt?.graphModifiedMs : undefined)
  const resourceStat = exactResourceModifiedMs !== undefined && resourceContent !== undefined ? null : statSync(resourcePath)
  const resourceModifiedMs = exactResourceModifiedMs ?? truncateMtime(resourceStat!.mtimeMs)
  const resourceName = basename(resourcePath)
  const graphFreshness = resourceContent === undefined
    ? graphFreshnessMetadata(graphPath)
    : (() => {
        const graphModifiedMs = receipt?.graphModifiedMs ?? (resourcePath === graphPath ? resourceModifiedMs : truncateMtime(statSync(graphPath).mtimeMs))
        return { graphVersion: (validatedGraphHash ?? createHash('sha256').update(resourceContent).digest('hex')).slice(0, VERSION_HASH_LENGTH), graphModifiedMs, graphModifiedAt: new Date(graphModifiedMs).toUTCString() }
      })()
  const resourceBytes = resourceContent === undefined ? resourceStat!.size : Buffer.byteLength(resourceContent)

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
