import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import { buildSadeemPromptPack } from '../../infrastructure/compare.js'
import type { TaskContextPlan } from '../../contracts/task-context-plan.js'
import type { CompareRefsInput } from '../../infrastructure/time-travel.js'
import type {
  ContextPackClaim,
  ContextPackCoverage,
  ContextPackEvidenceClass,
  ContextPackExpandableFollowUp,
  ContextPackExpandableRef,
  ContextPackNode,
  ContextPackRetrievalStrategy,
  ContextPackRelationship,
  ContextRepresentationType,
} from '../../contracts/context-pack.js'
import type { ContextSessionState } from '../../contracts/context-session.js'
import { buildCommunityLabels } from '../../pipeline/community-naming.js'
import { communityDetailsAtZoom, communityDetailsMicro, type CommunityZoomLevel } from '../../pipeline/community-details.js'
import { lineNumberFromSourceLocation, lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { validateGraphPath } from '../../shared/security.js'
import { featureMap } from '../feature-map.js'
import { implementationChecklist } from '../implementation-checklist.js'
import { classifyTaskContract, compileContextPack, estimateContextPackEntryTokens, type ContextPackNodeCandidate } from '../context-pack.js'
import type { RetrievalGateDecision } from '../../contracts/retrieval-gate.js'
import { classifyRetrievalLevel } from '../retrieval-gate.js'
import { pickImpactTarget } from '../context-pack-target.js'
import { analyzeImpact, callChains, compactImpactResult, type ImpactResult } from '../impact.js'
import { analyzePrImpact, compactPrImpactResult } from '../pr-impact.js'
import { relevantFiles } from '../relevant-files.js'
import { collectRelationships, compactRetrieveResult, contextPackFromRetrieveResult, readSnippet, retrieveContext, retrieveContextAsync, type RetrieveResult } from '../retrieve.js'
import { computeContextPackDiagnostics } from '../context-pack-diagnostics.js'
import { collectPackNodeIds, computeDeltaContextPack } from '../context-pack-delta.js'
import { applyContextPackResolution, type ContextPackResolution } from '../context-pack-resolution.js'
import { riskMap } from '../risk-map.js'
import { buildTaskContextPlan } from '../task-context-planner.js'
import type { TimeTravelView } from '../time-travel.js'
import { graphFreshnessMetadata } from '../freshness.js'
import { buildGraphSummary } from '../graph-summary.js'
import {
  communitiesFromGraph,
  getCommunity,
  getNeighbors,
  getNode,
  godNodesSummary,
  graphStats,
  queryGraph,
  semanticAnomaliesSummary,
  shortestPath,
} from '../serve.js'
import type { KnowledgeGraph } from '../../contracts/graph.js'

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

interface ToolHelpers {
  ok(id: string | number | null, result: unknown): StdioResponse
  failure(id: string | number | null, code: number, message: string): StdioResponse
  textToolResult(text: string): { content: Array<{ type: 'text'; text: string }> }
  stringParam(params: unknown, key: string): string | null
  stringParamAlias(params: unknown, keys: readonly string[]): string | null
  numberParamAlias(params: unknown, keys: readonly string[], options?: { min?: number; max?: number }): number | null
  recordParam(params: unknown, key: string): Record<string, unknown> | null
  loadGraphCached(graphPath: string): KnowledgeGraph
  queryOptionsFromParams(id: string | number | null, params: unknown): { failureResponse?: StdioResponse; queryOptions?: Record<string, unknown> }
  handleGraphDiff(id: string | number | null, currentGraphPath: string, params: unknown): StdioResponse
  compareRefs(input: CompareRefsInput): Promise<unknown>
  getContextPromptSession(sessionId: string): ContextSessionState | undefined
  setContextPromptSession(sessionId: string, nextState: ContextSessionState): void
  clearContextPromptSession(sessionId: string): boolean
  getContextPackHandle(handleId: string): unknown
  setContextPackHandle(handleId: string, expansion: unknown): void
  getContextPackCache(cacheKey: string): string | undefined
  setContextPackCache(cacheKey: string, payloadText: string): void
  clearContextPackCache(cacheKey: string): boolean
  /** Slice #81 — returns node ids already shipped to this delta session. */
  getContextPackNodeIds(sessionId: string): string[]
  /** Slice #81 — records additional node ids shipped to a delta session. */
  recordContextPackNodeIds(sessionId: string, nodeIds: string[]): void
  /** Slice #81 — clears the recorded node-id set for a delta session. */
  clearContextPackNodeIds(sessionId: string): boolean
  readStoredCommunityLabels(graphPath: string): Record<number, string>
  jsonrpcInvalidParams: number
  jsonrpcServerError: number
  maxStdioTextLength: number
  maxStdioHops: number
  maxStdioTokenBudget: number
}

const TIME_TRAVEL_VIEWS = new Set<TimeTravelView>(['summary', 'risk', 'drift', 'timeline'])

interface ContextPlaneMetadata {
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage: ContextPackCoverage
  missing_context: ContextPackEvidenceClass[]
  missing_semantic: ContextPackCoverage['missing_semantic']
  retrieval_gate?: RetrievalGateDecision
}

interface StoredContextPackHandle {
  prompt: string
  task: 'explain' | 'review' | 'impact'
  task_intent: TaskContextPlan['evidence']['recipe_id']
  follow_up: ContextPackExpandableFollowUp
}

interface ContextPackCacheEnvelope {
  status: 'hit' | 'miss'
  graph_version: string
}

interface CachedExplainContextPackPayload extends Record<string, unknown> {
  task: 'explain'
  prompt: string
  task_intent: TaskContextPlan['evidence']['recipe_id']
  expandable: ContextPackExpandableRef[]
}

function isStoredContextPackHandle(value: unknown): value is StoredContextPackHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.prompt !== 'string') {
    return false
  }
  if (candidate.task !== 'explain' && candidate.task !== 'review' && candidate.task !== 'impact') {
    return false
  }
  if (typeof candidate.task_intent !== 'string') {
    return false
  }
  if (!candidate.follow_up || typeof candidate.follow_up !== 'object' || Array.isArray(candidate.follow_up)) {
    return false
  }

  const followUp = candidate.follow_up as Record<string, unknown>
  return followUp.kind === 'context_pack'
    && typeof followUp.task_kind === 'string'
    && typeof followUp.evidence_class === 'string'
    && Array.isArray(followUp.focus_files)
    && Array.isArray(followUp.focus_ranges)
}

function parseRetrievalStrategyParam(
  helpers: Pick<ToolHelpers, 'stringParamAlias'>,
  toolArguments: Record<string, unknown>,
): ContextPackRetrievalStrategy | null | 'invalid' {
  const raw = helpers.stringParamAlias(toolArguments, ['retrieval_strategy', 'retrievalStrategy'])
  if (raw === null) {
    return null
  }
  if (raw === 'default' || raw === 'slice-v1') {
    return raw
  }
  return 'invalid'
}

function isContextPackEvidenceClass(value: unknown): value is ContextPackEvidenceClass {
  return value === 'primary'
    || value === 'supporting'
    || value === 'structural'
    || value === 'change'
    || value === 'impact'
}

function isContextPackTaskKind(value: unknown): value is 'explain' | 'review' | 'impact' {
  return value === 'explain' || value === 'review' || value === 'impact'
}

function isExpandableSourceRange(value: unknown): value is ContextPackExpandableFollowUp['focus_ranges'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.source_file === 'string'
    && typeof candidate.start_line === 'number'
    && Number.isInteger(candidate.start_line)
    && typeof candidate.end_line === 'number'
    && Number.isInteger(candidate.end_line)
}

function isContextPackExpandableFollowUp(value: unknown): value is ContextPackExpandableFollowUp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return candidate.kind === 'context_pack'
    && isContextPackTaskKind(candidate.task_kind)
    && isContextPackEvidenceClass(candidate.evidence_class)
    && Array.isArray(candidate.focus_files)
    && candidate.focus_files.every((entry) => typeof entry === 'string')
    && Array.isArray(candidate.focus_ranges)
    && candidate.focus_ranges.every((entry) => isExpandableSourceRange(entry))
}

function isContextPackExpandableRef(value: unknown): value is ContextPackExpandableRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return candidate.kind === 'nodes'
    && typeof candidate.handle_id === 'string'
    && isContextPackEvidenceClass(candidate.evidence_class)
    && typeof candidate.count === 'number'
    && Number.isInteger(candidate.count)
    && candidate.count >= 0
    && Array.isArray(candidate.preview)
    && isContextPackExpandableFollowUp(candidate.follow_up)
}

function isCachedExplainContextPackPayload(value: unknown): value is CachedExplainContextPackPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return candidate.task === 'explain'
    && typeof candidate.prompt === 'string'
    && typeof candidate.task_intent === 'string'
    && Array.isArray(candidate.expandable)
    && candidate.expandable.every((entry) => isContextPackExpandableRef(entry))
}

function parseContextPackResolution(raw: string | null): ContextPackResolution {
  return raw === 'summary'
    || raw === 'mixed'
    || raw === 'signature'
    || raw === 'sketch'
    ? raw
    : 'detail'
}

function buildContextPackCacheKey(input: {
  graphPath: string
  graphVersion: string
  prompt: string
  task: 'explain'
  budget: number
  retrievalLevel: 0 | 1 | 2 | 3 | 4 | 5 | null
  retrievalStrategy: ContextPackRetrievalStrategy | null
  resolution: ContextPackResolution
  verbose: boolean
}): string {
  return JSON.stringify({
    graph_path: input.graphPath,
    graph_version: input.graphVersion,
    tool: 'context_pack',
    prompt: input.prompt,
    task: input.task,
    budget: input.budget,
    retrieval_level: input.retrievalLevel,
    retrieval_strategy: input.retrievalStrategy,
    resolution: input.resolution,
    verbose: input.verbose,
  })
}

function withContextPackCache<T extends Record<string, unknown>>(
  payload: T,
  cache: ContextPackCacheEnvelope,
): T & { cache: ContextPackCacheEnvelope } {
  return {
    ...payload,
    cache,
  }
}

function emptyCoverage(): ContextPackCoverage {
  return {
    required_evidence: [],
    semantic_required: [],
    semantic_optional: [],
    entries: [],
    semantic_entries: [],
    missing_required: [],
    missing_semantic: [],
    available_relationships: 0,
    selected_relationships: 0,
  }
}

function contextMetadata(
  payload: Partial<{
    claims: ContextPackClaim[]
    expandable: ContextPackExpandableRef[]
    coverage: ContextPackCoverage
    retrieval_gate: RetrievalGateDecision
  }>,
): ContextPlaneMetadata {
  const coverage = payload.coverage ?? emptyCoverage()
  return {
    claims: payload.claims ?? [],
    expandable: payload.expandable ?? [],
    coverage,
    missing_context: coverage.missing_required,
    missing_semantic: coverage.missing_semantic,
    ...(payload.retrieval_gate ? { retrieval_gate: payload.retrieval_gate } : {}),
  }
}

function parseContextSessionState(raw: unknown): ContextSessionState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const record = raw as Record<string, unknown>
  if (record.version !== 1 || typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 0) {
    return null
  }
  if (!record.refs || typeof record.refs !== 'object' || Array.isArray(record.refs)) {
    return null
  }

  const refs: ContextSessionState['refs'] = {}
  for (const [ref, value] of Object.entries(record.refs as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const stored = value as Record<string, unknown>
    if (typeof stored.hash !== 'string' || typeof stored.token_count !== 'number' || !Number.isFinite(stored.token_count)) {
      return null
    }
    refs[ref] = {
      hash: stored.hash,
      token_count: stored.token_count,
    }
  }

  return {
    version: 1,
    revision: record.revision,
    refs,
  }
}

function createImpactCandidate(
  node: {
    label: string
    source_file: string
    file_type?: string
    community?: number | null
    community_label?: string | null
    node_kind?: string
    framework_role?: string | null
  },
  evidenceClass: ContextPackEvidenceClass,
): ContextPackNodeCandidate<ContextPackNode> {
  let builtEntry: ContextPackNode | undefined
  let tokenCost: number | undefined
  const sourceFile = node.source_file

  const buildEntry = (): ContextPackNode => {
    if (builtEntry) {
      return builtEntry
    }

    builtEntry = {
      label: node.label,
      source_file: sourceFile,
      line_number: 0,
      snippet: null,
      ...(node.file_type ? { file_type: node.file_type } : {}),
      ...(typeof node.community === 'number' ? { community: node.community } : {}),
      ...(node.community_label !== undefined ? { community_label: node.community_label } : {}),
      ...(node.node_kind ? { node_kind: node.node_kind } : {}),
      ...(node.framework_role ? { framework_role: node.framework_role } : {}),
      evidence_class: evidenceClass,
    }
    tokenCost = estimateContextPackEntryTokens(node.label, sourceFile, 0, null)
    return builtEntry
  }

  return {
    label: node.label,
    source_file: sourceFile,
    line_number: 0,
    ...(node.file_type ? { file_type: node.file_type } : {}),
    ...(node.node_kind ? { node_kind: node.node_kind } : {}),
    evidence_class: evidenceClass,
    ...(node.community !== undefined ? { community: node.community } : {}),
    estimate_tokens: () => {
      if (tokenCost !== undefined) {
        return tokenCost
      }

      buildEntry()
      return tokenCost ?? 0
    },
    build_entry: buildEntry,
  }
}

function snippetSourcePathCandidates(graphPath: string, sourceFile: string): string[] {
  if (sourceFile.trim().length === 0) {
    return []
  }

  const graphDir = dirname(graphPath)
  const projectDir = basename(graphDir) === 'out' ? dirname(graphDir) : graphDir
  const roots = [...new Set([graphDir, projectDir].map((root) => resolve(root)))]
  const candidates = isAbsolute(sourceFile)
    ? [resolve(sourceFile)]
    : roots.map((root) => resolve(root, sourceFile))

  return [...new Set(candidates.filter((candidatePath) => roots.some((root) => pathIsInsideRoot(candidatePath, root))))]
}

function pathIsInsideRoot(candidatePath: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidatePath))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function resolvedFocusedLineNumber(attributes: Record<string, unknown>): { lineNumber: number; derived: boolean } {
  if (typeof attributes.line_number === 'number' && attributes.line_number > 0) {
    return {
      lineNumber: attributes.line_number,
      derived: false,
    }
  }

  return {
    lineNumber: lineNumberFromSourceLocation(attributes.source_location),
    derived: true,
  }
}

function readFocusedSnippet(
  graphPath: string,
  sourceFile: string,
  lineNumber: number,
  options: { derived?: boolean; fileCache?: Map<string, string[] | null> } = {},
): string | null {
  for (const candidatePath of snippetSourcePathCandidates(graphPath, sourceFile)) {
    const snippet = readSnippet(candidatePath, lineNumber, options)
    if (snippet !== null) {
      return snippet
    }
  }

  return null
}

function impactMetadata(
  result: ImpactResult,
  budget: number,
  prompt: string,
  taskIntent: TaskContextPlan['evidence']['recipe_id'],
  retrievalLevelOverride?: 0 | 1 | 2 | 3 | 4 | 5,
): ContextPlaneMetadata {
  const candidates: ContextPackNodeCandidate<ContextPackNode>[] = []

  if (result.target_file.trim().length > 0) {
    candidates.push(createImpactCandidate({
      label: result.target,
      source_file: result.target_file,
      ...(result.target_file_type ? { file_type: result.target_file_type } : {}),
    }, 'primary'))
  }

  candidates.push(
    ...result.direct_dependents.map((node) => createImpactCandidate(node, 'impact')),
    ...result.transitive_dependents.map((node) => createImpactCandidate(node, 'structural')),
  )

  const pack = compileContextPack({
    task_contract: classifyTaskContract('impact', { budget, prompt, task_intent: taskIntent }),
    nodes: candidates,
    community_context: result.affected_communities,
    retrieval_gate: classifyRetrievalLevel({
      prompt,
      ...(retrievalLevelOverride !== undefined ? { manualOverride: retrievalLevelOverride } : {}),
    }),
  })

  return contextMetadata(pack)
}

function portableSourcePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function sourceFileMatchesFocus(sourceFile: string, focusFiles: readonly string[]): boolean {
  const normalizedSource = portableSourcePath(sourceFile)
  return focusFiles.some((focusFile) => {
    const normalizedFocus = portableSourcePath(focusFile)
    return normalizedSource === normalizedFocus
      || normalizedSource.endsWith(`/${normalizedFocus}`)
      || normalizedFocus.endsWith(`/${normalizedSource}`)
  })
}

function rangeOverlaps(
  sourceRange: ReturnType<typeof lineRangeFromSourceLocation>,
  focusRange: ContextPackExpandableFollowUp['focus_ranges'][number],
): boolean {
  if (sourceRange === null) {
    return false
  }

  return sourceRange.start <= focusRange.end_line && focusRange.start_line <= sourceRange.end
}

function relevanceBandForEvidenceClass(evidenceClass: ContextPackEvidenceClass): RetrieveResult['matched_nodes'][number]['relevance_band'] {
  switch (evidenceClass) {
    case 'primary':
    case 'change':
      return 'direct'
    case 'supporting':
    case 'impact':
      return 'related'
    case 'structural':
      return 'peripheral'
  }
}

function contextPackBasePayload(
  task: 'explain' | 'review' | 'impact',
  prompt: string,
  budget: number,
  graphPath: string,
  plan: TaskContextPlan,
) {
  return {
    task,
    task_intent: plan.evidence.recipe_id,
    prompt,
    budget,
    graph_path: graphPath,
    plan,
  }
}

function storeExpandableHandles(
  prompt: string,
  task: 'explain' | 'review' | 'impact',
  taskIntent: TaskContextPlan['evidence']['recipe_id'],
  expandable: readonly ContextPackExpandableRef[],
  helpers: ToolHelpers,
): void {
  for (const entry of expandable) {
    helpers.setContextPackHandle(entry.handle_id, {
      prompt,
      task,
      task_intent: taskIntent,
      follow_up: entry.follow_up,
    } satisfies StoredContextPackHandle)
  }
}

function buildFocusedExpansionPayload(
  graph: KnowledgeGraph,
  graphPath: string,
  handleId: string,
  stored: StoredContextPackHandle,
  budget: number,
  helpers: ToolHelpers,
): Record<string, unknown> {
  const plannerBudget = Math.max(budget, 3)
  const communities = communitiesFromGraph(graph)
  const communityLabels = {
    ...buildCommunityLabels(graph, communities),
    ...helpers.readStoredCommunityLabels(graphPath),
  }
  const focusFiles = stored.follow_up.focus_files
  const focusRanges = stored.follow_up.focus_ranges
  const nodeCandidates: Array<ContextPackNodeCandidate<ContextPackNode>> = []
  const communityIds = new Set<number>()
  const includedIds = new Set<string>()
  const snippetFileCache = new Map<string, string[] | null>()

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const sourceFile = String(attributes.source_file ?? '').trim()
    if (sourceFile.length === 0 || !sourceFileMatchesFocus(sourceFile, focusFiles)) {
      continue
    }

    const sourceRange = lineRangeFromSourceLocation(attributes.source_location)
    const matchingRanges = focusRanges.filter((range) => sourceFileMatchesFocus(sourceFile, [range.source_file]))
    if (matchingRanges.length > 0 && sourceRange !== null && !matchingRanges.some((range) => rangeOverlaps(sourceRange, range))) {
      continue
    }

    const community = typeof attributes.community === 'number' ? attributes.community : null
    if (community !== null) {
      communityIds.add(community)
    }
    includedIds.add(nodeId)
    let builtEntry: ContextPackNode | undefined
    let tokenCost: number | undefined
    const { lineNumber, derived } = resolvedFocusedLineNumber(attributes)

    nodeCandidates.push({
      label: String(attributes.label ?? nodeId),
      node_id: nodeId,
      source_file: sourceFile,
      line_number: lineNumber,
      evidence_class: stored.follow_up.evidence_class,
      ...(community !== null ? { community } : {}),
      ...(String(attributes.file_type ?? '').trim().length > 0 ? { file_type: String(attributes.file_type ?? '').trim() } : {}),
      ...(String(attributes.node_kind ?? '').trim().length > 0 ? { node_kind: String(attributes.node_kind ?? '').trim() } : {}),
      estimate_tokens: () => {
        if (tokenCost !== undefined) {
          return tokenCost
        }

        tokenCost = estimateContextPackEntryTokens(
          String(attributes.label ?? nodeId),
          sourceFile,
          lineNumber,
          builtEntry?.snippet ?? null,
        )
        return tokenCost
      },
      build_entry: () => {
        if (builtEntry) {
          return builtEntry
        }

        const snippet = readFocusedSnippet(graphPath, sourceFile, lineNumber, {
          derived: derived || sourceRange === null,
          fileCache: snippetFileCache,
        })
        builtEntry = {
          node_id: nodeId,
          label: String(attributes.label ?? nodeId),
          source_file: sourceFile,
          line_number: lineNumber,
          snippet,
          file_type: String(attributes.file_type ?? '') || undefined,
          community,
          community_label: community !== null ? (communityLabels[community] ?? null) : null,
          node_kind: String(attributes.node_kind ?? '') || undefined,
          framework_role: String(attributes.framework_role ?? '') || undefined,
          relevance_band: relevanceBandForEvidenceClass(stored.follow_up.evidence_class),
          evidence_class: stored.follow_up.evidence_class,
        }
        tokenCost = estimateContextPackEntryTokens(String(attributes.label ?? nodeId), sourceFile, lineNumber, snippet)
        return builtEntry
      },
    })
  }

  const plan = buildTaskContextPlan({
    task_kind: stored.task,
    prompt: stored.prompt,
    budget: plannerBudget,
    task_intent: stored.task_intent,
    focus_paths: focusFiles,
  })
  const pack = compileContextPack({
    task_contract: classifyTaskContract(stored.task, {
      budget,
      prompt: stored.prompt,
      task_intent: stored.task_intent,
    }),
    nodes: nodeCandidates,
    relationships: collectRelationships(graph, includedIds),
    community_context: [...communityIds]
      .map((communityId) => ({
        id: communityId,
        label: communityLabels[communityId] ?? `Community ${communityId}`,
        node_count: (communities[communityId] ?? []).length,
      }))
      .sort((left, right) => right.node_count - left.node_count),
    retrieval_gate: classifyRetrievalLevel({ prompt: stored.prompt }),
  })
  const retrieval: RetrieveResult = {
    question: stored.prompt,
    token_count: pack.token_count,
    matched_nodes: pack.nodes.map((node) => ({
      ...(node.node_id ? { node_id: node.node_id } : {}),
      label: node.label,
      source_file: node.source_file,
      line_number: node.line_number,
      ...(node.node_kind ? { node_kind: node.node_kind } : {}),
      ...(node.framework ? { framework: node.framework } : {}),
      ...(node.framework_role ? { framework_role: node.framework_role } : {}),
      ...(node.framework_boost !== undefined ? { framework_boost: node.framework_boost } : {}),
      file_type: node.file_type ?? '',
      snippet: node.snippet,
      match_score: node.match_score ?? 0,
      relevance_band: node.relevance_band ?? relevanceBandForEvidenceClass(node.evidence_class ?? stored.follow_up.evidence_class),
      community: node.community ?? null,
      community_label: node.community_label ?? null,
      ...(node.evidence_class ? { evidence_class: node.evidence_class } : {}),
    })),
    relationships: pack.relationships,
    community_context: pack.community_context,
    graph_signals: { god_nodes: [], bridge_nodes: [] },
    task_contract: pack.task_contract,
    claims: pack.claims,
    expandable: pack.expandable,
    coverage: pack.coverage,
  }
  const metadata = contextMetadata(pack)
  storeExpandableHandles(stored.prompt, stored.task, stored.task_intent, metadata.expandable, helpers)

  return {
    ...contextPackBasePayload(stored.task, stored.prompt, budget, graphPath, plan),
    handle_id: handleId,
    pack: compactRetrieveResult(retrieval),
    matched_focus: nodeCandidates.length,
    ...metadata,
  }
}

export function handleToolCall(id: string | number | null, graphPath: string, params: unknown, helpers: ToolHelpers): StdioResponse | Promise<StdioResponse> {
  const toolName = helpers.stringParam(params, 'name')
  if (!toolName) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `tools/call requires a string name parameter <= ${helpers.maxStdioTextLength} characters`)
  }

  const toolArguments = helpers.recordParam(params, 'arguments') ?? {}
  const graph = helpers.loadGraphCached(graphPath)

  switch (toolName) {
    case 'query_graph': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `query_graph requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const { failureResponse, queryOptions } = helpers.queryOptionsFromParams(id, toolArguments)
      if (failureResponse) {
        return failureResponse
      }

      return helpers.ok(id, helpers.textToolResult(queryGraph(graph, question, queryOptions)))
    }
    case 'get_node': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `get_node requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(getNode(graph, label)))
    }
    case 'graph_diff': {
      const diffResponse = helpers.handleGraphDiff(id, graphPath, toolArguments)
      return 'error' in diffResponse && diffResponse.error ? diffResponse : helpers.ok(id, helpers.textToolResult(String(diffResponse.result ?? '')))
    }
    case 'semantic_anomalies':
      return helpers.ok(id, helpers.textToolResult(semanticAnomaliesSummary(graphPath, helpers.numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 5)))
    case 'get_neighbors': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `get_neighbors requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(getNeighbors(graph, label, helpers.stringParamAlias(toolArguments, ['relation_filter', 'relation']) ?? '')))
    }
    case 'shortest_path': {
      const source = helpers.stringParam(toolArguments, 'source')
      const target = helpers.stringParam(toolArguments, 'target')
      if (!source || !target) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `shortest_path requires string source and target parameters <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(shortestPath(graph, source, target, helpers.numberParamAlias(toolArguments, ['max_hops', 'maxHops'], { min: 1, max: helpers.maxStdioHops }) ?? 8)))
    }
    case 'explain_node': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `explain_node requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      const relation = helpers.stringParamAlias(toolArguments, ['relation_filter', 'relation']) ?? ''
      return helpers.ok(id, helpers.textToolResult(`${getNode(graph, label)}\n\n${getNeighbors(graph, label, relation)}`))
    }
    case 'graph_stats':
      return helpers.ok(id, helpers.textToolResult(graphStats(graph)))
    case 'graph_summary':
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(buildGraphSummary(graph))))
    case 'god_nodes':
      return helpers.ok(id, helpers.textToolResult(godNodesSummary(graph, helpers.numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 10)))
    case 'get_community': {
      const communityId = helpers.numberParamAlias(toolArguments, ['community_id', 'communityId'], { min: 0 })
      if (communityId === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'get_community requires a numeric community_id parameter >= 0')
      }
      return helpers.ok(id, helpers.textToolResult(getCommunity(graph, communitiesFromGraph(graph), communityId)))
    }
    case 'community_details': {
      const detailCommunityId = helpers.numberParamAlias(toolArguments, ['community_id', 'communityId'], { min: 0 })
      if (detailCommunityId === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'community_details requires a numeric community_id parameter >= 0')
      }
      const zoomRaw = helpers.stringParam(toolArguments, 'zoom') ?? 'mid'
      const zoom: CommunityZoomLevel = zoomRaw === 'micro' || zoomRaw === 'mid' || zoomRaw === 'macro' ? zoomRaw : 'mid'
      const detailCommunities = communitiesFromGraph(graph)
      const detailLabels = { ...buildCommunityLabels(graph, detailCommunities), ...helpers.readStoredCommunityLabels(graphPath) }
      const details = communityDetailsAtZoom(graph, detailCommunities, detailLabels, detailCommunityId, zoom)
      if (!details) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown community: ${detailCommunityId}`)
      }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(details)))
    }
    case 'community_overview': {
      const overviewCommunities = communitiesFromGraph(graph)
      const overviewLabels = { ...buildCommunityLabels(graph, overviewCommunities), ...helpers.readStoredCommunityLabels(graphPath) }
      const overview = communityDetailsMicro(graph, overviewCommunities, overviewLabels)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(overview)))
    }
    case 'impact': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `impact requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      if (Object.hasOwn(toolArguments, 'compact') && typeof toolArguments.compact !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'compact must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'verbose') && typeof toolArguments.verbose !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'verbose must be a boolean')
      }
      const impactDepth = helpers.numberParamAlias(toolArguments, ['depth'], { min: 1, max: 5 })
      const rawEdgeTypes = toolArguments.edge_types
      const edgeTypes = Array.isArray(rawEdgeTypes) ? rawEdgeTypes.filter((t): t is string => typeof t === 'string') : undefined
      const communityLabels = helpers.readStoredCommunityLabels(graphPath)
      const impactResult = analyzeImpact(graph, communityLabels, {
        label,
        ...(impactDepth !== null ? { depth: impactDepth } : {}),
        ...(edgeTypes && edgeTypes.length > 0 ? { edgeTypes } : {}),
      })
      const useVerboseImpact = toolArguments.verbose === true || toolArguments.compact === false
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(
        useVerboseImpact
          ? impactResult
          : {
              ...compactImpactResult(impactResult),
              missing_context: [],
            },
      )))
    }
    case 'call_chain': {
      const chainSource = helpers.stringParam(toolArguments, 'source')
      const chainTarget = helpers.stringParam(toolArguments, 'target')
      if (!chainSource || !chainTarget) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `call_chain requires string source and target parameters <= ${helpers.maxStdioTextLength} characters`)
      }
      const chainMaxHops = helpers.numberParamAlias(toolArguments, ['max_hops', 'maxHops'], { min: 1, max: helpers.maxStdioHops })
      const rawChainEdgeTypes = toolArguments.edge_types
      const chainEdgeTypes = Array.isArray(rawChainEdgeTypes) ? rawChainEdgeTypes.filter((t): t is string => typeof t === 'string') : undefined
      const chains = callChains(graph, chainSource, chainTarget, chainMaxHops ?? 8, chainEdgeTypes)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({ source: chainSource, target: chainTarget, chains, total: chains.length })))
    }
    case 'pr_impact': {
      if (Object.hasOwn(toolArguments, 'compact') && typeof toolArguments.compact !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'compact must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'verbose') && typeof toolArguments.verbose !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'verbose must be a boolean')
      }
      const prBaseBranch = helpers.stringParamAlias(toolArguments, ['base_branch', 'baseBranch'])
      const prDepth = helpers.numberParamAlias(toolArguments, ['depth'], { min: 1, max: 5 })
      const prBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && prBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const graphDir = dirname(validateGraphPath(graphPath))
      const projectRoot = dirname(graphDir)
      const prResult = analyzePrImpact(graph, projectRoot, {
        ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
        ...(prDepth !== null ? { depth: prDepth } : {}),
        ...(prBudget !== null ? { budget: prBudget } : {}),
      })
      const useVerbosePrImpact = toolArguments.verbose === true || toolArguments.compact === false
      if (useVerbosePrImpact) {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(prResult)))
      }
      const compactPrImpact = compactPrImpactResult(prResult)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...compactPrImpact,
        missing_context: (prResult.review_bundle.coverage ?? emptyCoverage()).missing_required,
      })))
    }
    case 'retrieve': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `retrieve requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      if (Object.hasOwn(toolArguments, 'compact') && typeof toolArguments.compact !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'compact must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'verbose') && typeof toolArguments.verbose !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'verbose must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'semantic') && typeof toolArguments.semantic !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'semantic must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'rerank') && typeof toolArguments.rerank !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'rerank must be a boolean')
      }
      const retrieveBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (retrieveBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `retrieve requires a numeric budget parameter between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const retrieveCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const retrieveFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const retrieveSemantic = toolArguments.semantic === true
      const retrieveRerank = toolArguments.rerank === true
      const retrieveSemanticModel = helpers.stringParamAlias(toolArguments, ['semantic_model', 'semanticModel'])
      const retrieveRerankModel = helpers.stringParamAlias(toolArguments, ['rerank_model', 'rerankModel'])
      // #75 manual override: numeric retrieval_level argument (0-5) bypasses
      // the gate's heuristics and forces the supplied level. numberParamAlias
      // already enforces the range and returns null for absent/out-of-range
      // values, so we only forward when the argument is present.
      const retrieveLevelOverride = helpers.numberParamAlias(toolArguments, ['retrieval_level', 'retrievalLevel'], { min: 0, max: 5 })
      if ((Object.hasOwn(toolArguments, 'retrieval_level') || Object.hasOwn(toolArguments, 'retrievalLevel')) && retrieveLevelOverride === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'retrieval_level must be an integer between 0 and 5')
      }
      const retrieveStrategy = parseRetrievalStrategyParam(helpers, toolArguments)
      if (retrieveStrategy === 'invalid') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'retrieval_strategy must be one of default, slice-v1')
      }
      const retrieveLevelTyped = retrieveLevelOverride === null ? null : (retrieveLevelOverride as 0 | 1 | 2 | 3 | 4 | 5)
      const retrieval = retrieveSemantic || retrieveRerank ? retrieveContextAsync(graph, {
        question,
        budget: retrieveBudget,
        ...(retrieveCommunity !== null ? { community: retrieveCommunity } : {}),
        ...(retrieveFileType ? { fileType: retrieveFileType } : {}),
        ...(retrieveSemantic ? { semantic: true } : {}),
        ...(retrieveSemanticModel ? { semanticModel: retrieveSemanticModel } : {}),
        ...(retrieveRerank ? { rerank: true } : {}),
        ...(retrieveRerankModel ? { rerankerModel: retrieveRerankModel } : {}),
        ...(retrieveLevelTyped !== null ? { retrievalLevel: retrieveLevelTyped } : {}),
        ...(retrieveStrategy ? { retrievalStrategy: retrieveStrategy } : {}),
      }) : Promise.resolve(retrieveContext(graph, {
        question,
        budget: retrieveBudget,
        ...(retrieveCommunity !== null ? { community: retrieveCommunity } : {}),
          ...(retrieveFileType ? { fileType: retrieveFileType } : {}),
          ...(retrieveLevelTyped !== null ? { retrievalLevel: retrieveLevelTyped } : {}),
          ...(retrieveStrategy ? { retrievalStrategy: retrieveStrategy } : {}),
        }))
      const useVerboseRetrieve = toolArguments.verbose === true || toolArguments.compact === false
      return retrieval.then((result) => helpers.ok(id, helpers.textToolResult(JSON.stringify(
        useVerboseRetrieve
          ? result
          : {
              ...compactRetrieveResult(result),
              ...contextMetadata(result),
            },
      ))))
    }
    case 'context_pack': {
      const prompt = helpers.stringParam(toolArguments, 'prompt')
      if (!prompt) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_pack requires a string prompt parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const task = helpers.stringParam(toolArguments, 'task') ?? 'explain'
      if (task !== 'explain' && task !== 'review' && task !== 'impact') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'task must be one of explain, review, impact')
      }
      const budget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && budget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const resolvedBudget = budget ?? 3000
      const plannerBudget = Math.max(resolvedBudget, 3)
      const initialPlan = buildTaskContextPlan({
        task_kind: task,
        prompt,
        budget: plannerBudget,
      })

      // CodeRabbit fix: validate resolution BEFORE the review/impact
      // early returns so callers can't pass resolution: 'summary' or
      // 'mixed' for review/impact tasks and get silent no-ops. The
      // resolution feature only applies to the explain branch in this
      // slice; review and impact branches produce different pack
      // taxonomies that would need their own adapters.
      const earlyResolutionParam = helpers.stringParam(toolArguments, 'resolution')
      if (earlyResolutionParam && (task === 'review' || task === 'impact')) {
        return helpers.failure(
          id,
          helpers.jsonrpcInvalidParams,
          `resolution is only supported for task=explain (got task=${task}). Drop the parameter or switch tasks.`,
        )
      }

      const contextPackStrategy = parseRetrievalStrategyParam(helpers, toolArguments)
      if (contextPackStrategy === 'invalid') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'retrieval_strategy must be one of default, slice-v1')
      }
      if (task === 'review' && contextPackStrategy) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'retrieval_strategy is not supported for task=review')
      }

      const contextPackLevelOverride = helpers.numberParamAlias(toolArguments, ['retrieval_level', 'retrievalLevel'], { min: 0, max: 5 })
      if ((Object.hasOwn(toolArguments, 'retrieval_level') || Object.hasOwn(toolArguments, 'retrievalLevel')) && contextPackLevelOverride === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'retrieval_level must be an integer between 0 and 5')
      }
      const contextPackLevelTyped = contextPackLevelOverride === null ? null : (contextPackLevelOverride as 0 | 1 | 2 | 3 | 4 | 5)
      const resolution = parseContextPackResolution(earlyResolutionParam)
      const includeSelectionDiagnostics = toolArguments.verbose === true
      const deltaSessionId = helpers.stringParamAlias(toolArguments, ['delta_session_id', 'deltaSessionId'])
      const cacheGraphVersion = !deltaSessionId && task === 'explain'
        ? graphFreshnessMetadata(graphPath).graphVersion
        : null
      const cacheKey = cacheGraphVersion
        ? buildContextPackCacheKey({
            graphPath,
            graphVersion: cacheGraphVersion,
            prompt,
            task: 'explain',
            budget: resolvedBudget,
            retrievalLevel: contextPackLevelTyped ?? null,
            retrievalStrategy: contextPackStrategy,
            resolution,
            verbose: includeSelectionDiagnostics,
          })
        : null
      if (cacheKey) {
        const cachedPayloadText = helpers.getContextPackCache(cacheKey)
        if (cachedPayloadText) {
          try {
            const cachedPayload = JSON.parse(cachedPayloadText)
            if (!isCachedExplainContextPackPayload(cachedPayload)) {
              throw new Error('Malformed cached explain context_pack payload')
            }
            storeExpandableHandles(
              cachedPayload.prompt,
              'explain',
              cachedPayload.task_intent,
              cachedPayload.expandable,
              helpers,
            )
            return helpers.ok(id, helpers.textToolResult(JSON.stringify(withContextPackCache(cachedPayload, {
              status: 'hit',
              graph_version: cacheGraphVersion!,
            }))))
          } catch {
            helpers.clearContextPackCache(cacheKey)
          }
        }
      }

      if (task === 'review') {
        const graphDir = dirname(validateGraphPath(graphPath))
        const projectRoot = dirname(graphDir)
        const prResult = analyzePrImpact(graph, projectRoot, {
          budget: resolvedBudget,
          taskIntent: initialPlan.evidence.recipe_id,
        })
        const compactPack = compactPrImpactResult(prResult)
        const reviewMetadata = contextMetadata(prResult.review_bundle)
        storeExpandableHandles(prompt, task, initialPlan.evidence.recipe_id, reviewMetadata.expandable, helpers)
        const plan = buildTaskContextPlan({
          task_kind: 'review',
          prompt,
          budget: plannerBudget,
          task_intent: initialPlan.evidence.recipe_id,
          changed_paths: prResult.changed_files,
          focus_paths: [...prResult.review_context.supporting_paths, ...prResult.review_context.test_paths],
        })
        const payload = {
          ...contextPackBasePayload(task, prompt, resolvedBudget, graphPath, plan),
          pack: compactPack,
          ...reviewMetadata,
        }
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(payload)))
      }

      const retrieval = retrieveContext(graph, {
        question: prompt,
        budget: resolvedBudget,
        taskIntent: initialPlan.evidence.recipe_id,
        ...(contextPackLevelTyped !== null ? { retrievalLevel: contextPackLevelTyped } : {}),
        ...(contextPackStrategy ? { retrievalStrategy: contextPackStrategy } : {}),
      })

      if (task === 'impact') {
        const communityLabels = {
          ...buildCommunityLabels(graph, communitiesFromGraph(graph)),
          ...helpers.readStoredCommunityLabels(graphPath),
        }
        const impactTarget = pickImpactTarget(retrieval)
        const impactResult = analyzeImpact(graph, communityLabels, {
          label: impactTarget,
          depth: 3,
        })
        const impactPack = compactImpactResult(impactResult)
        const metadata = impactMetadata(impactResult, resolvedBudget, prompt, initialPlan.evidence.recipe_id, contextPackLevelTyped ?? undefined)
        storeExpandableHandles(prompt, task, initialPlan.evidence.recipe_id, metadata.expandable, helpers)
        return helpers.ok(id, helpers.textToolResult(JSON.stringify({
          ...contextPackBasePayload(task, prompt, resolvedBudget, graphPath, initialPlan),
          target: impactTarget,
          pack: impactPack,
          ...metadata,
        })))
      }

      const fullPack = contextPackFromRetrieveResult(retrieval)
      const compactPack = compactRetrieveResult(retrieval)
      const metadata = contextMetadata(retrieval)
      storeExpandableHandles(prompt, task, initialPlan.evidence.recipe_id, metadata.expandable, helpers)
      // Slice #78: emit context-pack quality diagnostics so callers can
      // detect bad runs (missing required evidence, zero claims, weak
      // retrieval, etc.) without re-implementing the heuristics.
      const diagnostics = computeContextPackDiagnostics(fullPack)

      // Slice #76/#135: multi-resolution context. Default 'detail'
      // preserves existing behavior; 'summary' drops snippet bodies;
      // 'mixed' keeps top-N most relevant nodes in detail; 'signature'
      // keeps declaration shape; 'sketch' emits graph-derived behavior /
      // dependency compression when relationship data exists.
       const applyResolutionToNodes = <T>(
         nodes: T[],
         relationships?: readonly ContextPackRelationship[],
      ): {
        nodes: T[]
        bytes_saved: number
        resolution_map: Array<{ node_id: string | undefined; resolution: ContextRepresentationType }>
      } => {
        if (resolution === 'detail') {
          return {
            nodes,
            bytes_saved: 0,
            resolution_map: (nodes as unknown as ContextPackNode[]).map((n) => ({
              node_id: n.node_id,
              resolution: 'detail' as const,
            })),
          }
        }
        // applyContextPackResolution preserves all fields and only
        // mutates `snippet` to null, so the shape is structurally
        // compatible with T. The exactOptionalPropertyTypes rule can't
        // see through the spread; the as-cast bridges it.
        // CodeRabbit fix: forward resolution_map so callers know which
        // nodes were summarized vs kept in detail.
        const result = applyContextPackResolution(
          nodes as unknown as ContextPackNode[],
          relationships ? { resolution, relationships } : { resolution },
        )
        return {
          nodes: result.nodes as unknown as T[],
          bytes_saved: result.bytes_saved,
          resolution_map: result.resolution_map,
        }
      }

      // Slice #81: delta-only context packs. When the caller passes a
      // delta_session_id we filter out nodes the agent has already
      // received in earlier turns of the same session, ship only the
      // delta + referenced_ids, and record the new ids for the next call.
      // The session store is per-MCP-process (in-memory) so two parallel
      // agents using the same id naturally diverge — that's intentional.
      if (deltaSessionId) {
        const previouslySent = helpers.getContextPackNodeIds(deltaSessionId)
        const deltaResult = computeDeltaContextPack(fullPack, previouslySent)
        // Record the newly-shipped node ids so the next call's delta is
        // computed against the union of everything sent so far.
        helpers.recordContextPackNodeIds(deltaSessionId, collectPackNodeIds(deltaResult.delta_pack))
        const deltaNodesStripped = deltaResult.delta_pack.nodes.map((node) => {
          const { evidence_class: _evidenceClass, ...rest } = node
          return rest
        })
        const resolvedDeltaNodes = applyResolutionToNodes(deltaNodesStripped, deltaResult.delta_pack.relationships)
        return helpers.ok(id, helpers.textToolResult(JSON.stringify({
          ...contextPackBasePayload(task, prompt, resolvedBudget, graphPath, initialPlan),
          mode: 'delta',
          delta_session_id: deltaSessionId,
          delta_applied: deltaResult.delta_applied,
          referenced_ids: deltaResult.referenced_ids,
          bytes_saved: deltaResult.bytes_saved + resolvedDeltaNodes.bytes_saved,
          resolution,
          pack: {
            question: prompt,
            token_count: deltaResult.delta_pack.token_count,
            matched_nodes: resolvedDeltaNodes.nodes,
            relationships: deltaResult.delta_pack.relationships,
            community_context: deltaResult.delta_pack.community_context,
            graph_signals: deltaResult.delta_pack.graph_signals ?? { god_nodes: [], bridge_nodes: [] },
          },
          diagnostics: computeContextPackDiagnostics(deltaResult.delta_pack, { skipBudgetUnderutilization: true }),
          ...(includeSelectionDiagnostics && deltaResult.delta_pack.selection_diagnostics
            ? { selection_diagnostics: deltaResult.delta_pack.selection_diagnostics }
            : {}),
          ...metadata,
        })))
      }
      const resolvedNodes = applyResolutionToNodes(compactPack.matched_nodes, compactPack.relationships)
      const basePayload = {
        ...contextPackBasePayload(task, prompt, resolvedBudget, graphPath, initialPlan),
        resolution,
        pack: {
          ...compactPack,
          matched_nodes: resolvedNodes.nodes,
        },
        ...(resolvedNodes.bytes_saved > 0
          ? { bytes_saved_by_resolution: resolvedNodes.bytes_saved, resolution_map: resolvedNodes.resolution_map }
          : {}),
        diagnostics,
        ...(includeSelectionDiagnostics && fullPack.selection_diagnostics
          ? { selection_diagnostics: fullPack.selection_diagnostics }
          : {}),
        ...metadata,
      }
      if (!cacheKey || !cacheGraphVersion) {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(basePayload)))
      }
      const payloadText = JSON.stringify(withContextPackCache(basePayload, {
        status: 'miss',
        graph_version: cacheGraphVersion,
      }))
      helpers.setContextPackCache(cacheKey, payloadText)
      return helpers.ok(id, helpers.textToolResult(payloadText))
    }
    case 'context_pack_session_reset': {
      const sessionId = helpers.stringParamAlias(toolArguments, ['delta_session_id', 'deltaSessionId', 'session_id', 'sessionId'])
      if (!sessionId) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'context_pack_session_reset requires a string delta_session_id parameter')
      }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        delta_session_id: sessionId,
        cleared: helpers.clearContextPackNodeIds(sessionId),
      })))
    }
    case 'context_expand': {
      const handleId = helpers.stringParamAlias(toolArguments, ['handle_id', 'handleId'])
      if (!handleId) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_expand requires a string handle_id parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      const budget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && budget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const stored = helpers.getContextPackHandle(handleId)
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown context_pack handle_id '${handleId}'. Expand handles are only available within the MCP session that produced them.`)
      }
      if (!isStoredContextPackHandle(stored)) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Malformed context_pack handle_id '${handleId}'. Re-run context_pack and retry context_expand within the same MCP session.`)
      }

      const payload = buildFocusedExpansionPayload(
        graph,
        graphPath,
        handleId,
        stored,
        budget ?? 1500,
        helpers,
      )
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(payload)))
    }
    case 'context_prompt': {
      const prompt = helpers.stringParam(toolArguments, 'prompt')
      if (!prompt) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_prompt requires a string prompt parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      const provider = helpers.stringParam(toolArguments, 'provider')
      if (provider !== 'claude' && provider !== 'gemini') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'provider must be one of claude, gemini')
      }
      const budget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && budget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const sessionId = helpers.stringParamAlias(toolArguments, ['session_id', 'sessionId'])
      const explicitSessionStateRaw = toolArguments.session_state ?? toolArguments.sessionState
      const explicitSessionState = explicitSessionStateRaw === undefined ? undefined : parseContextSessionState(explicitSessionStateRaw)
      if (explicitSessionStateRaw !== undefined && explicitSessionState === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'session_state must be a valid context session payload')
      }
      if (Object.hasOwn(toolArguments, 'reset_session') && typeof toolArguments.reset_session !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'reset_session must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'resetSession') && typeof toolArguments.resetSession !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'resetSession must be a boolean')
      }
      const resetSession = toolArguments.reset_session === true || toolArguments.resetSession === true
      if (resetSession && sessionId) {
        helpers.clearContextPromptSession(sessionId)
      }

      const retrieval = retrieveContext(graph, {
        question: prompt,
        budget: budget ?? 3000,
      })
      const previousSession =
        explicitSessionState
        ?? (sessionId ? helpers.getContextPromptSession(sessionId) : undefined)
      const promptPack = buildSadeemPromptPack({
        question: prompt,
        retrieval,
        ...(provider === 'claude' && previousSession ? { session: previousSession } : {}),
      })
      if (provider === 'claude' && sessionId) {
        helpers.setContextPromptSession(sessionId, promptPack.session_state)
      }

      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        provider,
        prompt,
        graph_path: graphPath,
        compiled: provider === 'claude'
          ? {
              provider,
              format: 'session_payload',
              prompt: promptPack.session_payload,
              token_count: promptPack.token_count,
              session_payload_token_count: promptPack.session_payload_token_count,
              effective_token_count: promptPack.effective_token_count,
              reused_context_tokens: promptPack.reused_context_tokens,
              session_state: promptPack.session_state,
              ...(sessionId ? { session_id: sessionId } : {}),
            }
          : {
              provider,
              format: 'prompt',
              prompt: promptPack.prompt,
              token_count: promptPack.token_count,
            },
        ...contextMetadata(retrieval),
      })))
    }
    case 'context_session_reset': {
      const sessionId = helpers.stringParamAlias(toolArguments, ['session_id', 'sessionId'])
      if (!sessionId) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_session_reset requires a string session_id parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        session_id: sessionId,
        cleared: helpers.clearContextPromptSession(sessionId),
      })))
    }
    case 'relevant_files': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `relevant_files requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const relevantBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && relevantBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }

      const relevantLimit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 1, max: 50 })
      if (Object.hasOwn(toolArguments, 'limit') && relevantLimit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 1 and 50')
      }

      const relevantCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const relevantFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = relevantFiles(graph, {
        question,
        budget: relevantBudget ?? 4000,
        ...(relevantLimit !== null ? { limit: relevantLimit } : {}),
        ...(relevantCommunity !== null ? { community: relevantCommunity } : {}),
        ...(relevantFileType ? { fileType: relevantFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
    }
    case 'feature_map': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `feature_map requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const featureBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && featureBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }

      const featureLimit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 1, max: 50 })
      if (Object.hasOwn(toolArguments, 'limit') && featureLimit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 1 and 50')
      }

      const featureCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const featureFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = featureMap(graph, {
        question,
        budget: featureBudget ?? 4000,
        ...(featureLimit !== null ? { limit: featureLimit } : {}),
        ...(featureCommunity !== null ? { community: featureCommunity } : {}),
        ...(featureFileType ? { fileType: featureFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
    }
    case 'risk_map': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `risk_map requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const riskBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && riskBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }

      const riskLimit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 1, max: 50 })
      if (Object.hasOwn(toolArguments, 'limit') && riskLimit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 1 and 50')
      }

      const riskCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const riskFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = riskMap(graph, {
        question,
        budget: riskBudget ?? 4000,
        ...(riskLimit !== null ? { limit: riskLimit } : {}),
        ...(riskCommunity !== null ? { community: riskCommunity } : {}),
        ...(riskFileType ? { fileType: riskFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
    }
    case 'implementation_checklist': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `implementation_checklist requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const checklistBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && checklistBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }

      const checklistLimit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 1, max: 50 })
      if (Object.hasOwn(toolArguments, 'limit') && checklistLimit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 1 and 50')
      }

      const checklistCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const checklistFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = implementationChecklist(graph, {
        question,
        budget: checklistBudget ?? 4000,
        ...(checklistLimit !== null ? { limit: checklistLimit } : {}),
        ...(checklistCommunity !== null ? { community: checklistCommunity } : {}),
        ...(checklistFileType ? { fileType: checklistFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
    }
    case 'time_travel_compare': {
      const fromRef = helpers.stringParamAlias(toolArguments, ['from_ref', 'fromRef'])
      const toRef = helpers.stringParamAlias(toolArguments, ['to_ref', 'toRef'])
      if (!fromRef || !toRef) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `time_travel_compare requires string from_ref and to_ref parameters <= ${helpers.maxStdioTextLength} characters`)
      }

      const rawView = helpers.stringParam(toolArguments, 'view')
      if (Object.hasOwn(toolArguments, 'view') && (!rawView || !TIME_TRAVEL_VIEWS.has(rawView as TimeTravelView))) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'view must be one of summary, risk, drift, timeline')
      }

      const limit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 0, max: 100 })
      if (Object.hasOwn(toolArguments, 'limit') && limit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 0 and 100')
      }

      const refresh = toolArguments.refresh
      if (Object.hasOwn(toolArguments, 'refresh') && typeof refresh !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'refresh must be a boolean')
      }

      return helpers.compareRefs({
        fromRef,
        toRef,
        ...(rawView ? { view: rawView as TimeTravelView } : {}),
        ...(typeof refresh === 'boolean' ? { refresh } : {}),
        ...(limit !== null ? { limit } : {}),
      }).then((result) => {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
      }).catch((error: unknown) => {
        return helpers.failure(id, helpers.jsonrpcServerError, error instanceof Error ? error.message : 'Time travel comparison failed')
      })
    }
    default:
      return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown tool: ${toolName}`)
  }
}
