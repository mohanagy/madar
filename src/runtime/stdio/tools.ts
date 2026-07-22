import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { buildMadarPromptPack } from '../../infrastructure/compare.js'
import { buildAnswerReadyPackSchema, buildExplainPackPayloadCore } from '../../infrastructure/context-pack-command.js'
import type { TaskContextPlan } from '../../contracts/task-context-plan.js'
import type { CompareRefsInput } from '../../infrastructure/time-travel.js'
import type { ContextPackRetrievalPlan, ContextPackRetrievalPlanDetail } from '../../contracts/retrieval-plan.js'
import type {
  ContextPackClaim,
  ContextPackCoverage,
  ContextPackEvidenceClass,
  ContextPackExecutionPhase,
  ContextPackExpandableFollowUp,
  ContextPackExpandableRef,
  ContextPackNode,
  ContextPackRetrievalStrategy,
  ContextPackRelationship,
  ContextPackTaskKind,
  ContextRepresentationType,
} from '../../contracts/context-pack.js'
import type { ContextSessionState } from '../../contracts/context-session.js'
import { buildCommunityLabels } from '../../pipeline/community-naming.js'
import { communityDetailsAtZoom, communityDetailsMicro, type CommunityZoomLevel } from '../../pipeline/community-details.js'
import { lineNumberFromSourceLocation, lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { resolveGraphSourceRoot } from '../../shared/graph-source-root.js'
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
import {
  collectRelationships,
  compactRetrieveResult,
  compactRetrieveResultForStdio,
  contextPackFromRetrieveResult,
  readSnippet,
  retrieveContext,
  retrieveContextAsync,
  withRetrieveSnippetBudget,
  type RetrieveResult,
  type RetrieveSnippetOptions,
} from '../retrieve.js'
import { reconcileRetrievalPlanQueryEvidence } from '../retrieve/conceptual-fallback.js'
import { buildRetrievalEvidencePlan } from '../retrieve/pipeline.js'
import { computeContextPackDiagnostics } from '../context-pack-diagnostics.js'
import { collectPackNodeIds, computeDeltaContextPack } from '../context-pack-delta.js'
import { buildContextPackGovernanceReceipt } from '../context-pack-governance.js'
import { applyContextPackResolution, type ContextPackResolution } from '../context-pack-resolution.js'
import { buildImplementationPackGuidance } from '../implementation-pack.js'
import {
  buildMadarResponseEvidence,
  collectWorkflowOwners,
  missingPhasesFromPayload,
} from '../mcp-response-evidence.js'
import { resolveTaskSelection } from '../task-intent.js'
import { riskMap } from '../risk-map.js'
import { buildTaskContextPlan } from '../task-context-planner.js'
import type { TimeTravelView } from '../time-travel.js'
import {
  analyzeGraphContextFreshness,
  graphFreshnessFromReceipt,
  requireFreshGraph,
  requireFreshSelectedContext,
  selectedContextSourceFilesFromRetrieveResult,
  type GraphContextFreshness,
} from '../freshness.js'
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
import type { KnowledgeGraph } from '../../domain/graph/directed-multigraph.js'
import type { GraphArtifactReceipt } from '../../adapters/filesystem/graph-artifact.js'

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
  errorToolResult(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true }
  stringParam(params: unknown, key: string): string | null
  stringParamAlias(params: unknown, keys: readonly string[]): string | null
  numberParamAlias(params: unknown, keys: readonly string[], options?: { min?: number; max?: number }): number | null
  recordParam(params: unknown, key: string): Record<string, unknown> | null
  loadGraphCached(graphPath: string): KnowledgeGraph
  loadGraphReceiptCached(graphPath: string): GraphArtifactReceipt
  queryOptionsFromParams(id: string | number | null, params: unknown): { failureResponse?: StdioResponse; queryOptions?: Record<string, unknown> }
  handleGraphDiff(id: string | number | null, currentGraphPath: string, params: unknown): StdioResponse
  compareRefs(input: CompareRefsInput): Promise<unknown>
  getContextPromptSession(sessionId: string): ContextSessionState | undefined
  setContextPromptSession(sessionId: string, nextState: ContextSessionState): void
  clearContextPromptSession(sessionId: string): boolean
  strictContextPackMode: boolean
  getContextPackHandle(handleId: string): unknown
  takeContextPackHandle(handleId: string): unknown
  setContextPackHandle(handleId: string, expansion: unknown): void
  clearContextPackHandles(): void
  getContextPackCache(cacheKey: string): string | undefined
  setContextPackCache(cacheKey: string, payloadText: string): void
  clearContextPackCache(cacheKey: string): boolean
  /** Slice #81 — returns node ids already shipped to this delta session. */
  getContextPackNodeIds(sessionId: string): string[]
  /** Slice #81 — records additional node ids shipped to a delta session. */
  recordContextPackNodeIds(sessionId: string, nodeIds: string[]): void
  /** Slice #81 — clears the recorded node-id set for a delta session. */
  clearContextPackNodeIds(sessionId: string): boolean
  readStoredCommunityLabels(graphPath: string, graph?: KnowledgeGraph): Record<number, string>
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
  task: ContextPackTaskKind
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
  expandable?: ContextPackExpandableRef[]
}

function reconcileSurfaceRetrievalPlan<T extends { label: string; source_file: string; snippet?: string | null }>(
  plan: ContextPackRetrievalPlan | undefined,
  question: string,
  nodes: readonly T[],
): ContextPackRetrievalPlan | undefined {
  if (!plan || !('initial' in plan) || !('final' in plan)) {
    return plan
  }

  return reconcileRetrievalPlanQueryEvidence(
    plan as ContextPackRetrievalPlanDetail,
    question,
    nodes,
  )
}

function isStoredContextPackHandle(value: unknown): value is StoredContextPackHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.prompt !== 'string') {
    return false
  }
  if (!isContextPackTaskKind(candidate.task)) {
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
    && isContextPackTaskKind(followUp.task_kind)
    && typeof followUp.evidence_class === 'string'
    && Array.isArray(followUp.focus_files)
    && (
      !Object.hasOwn(followUp, 'focus_ranges')
      || (
        Array.isArray(followUp.focus_ranges)
        && followUp.focus_ranges.every((entry) => isExpandableSourceRange(entry))
      )
    )
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

function isContextPackTaskKind(value: unknown): value is ContextPackTaskKind {
  return value === 'explain' || value === 'implement' || value === 'review' || value === 'impact'
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
    && (
      !Object.hasOwn(candidate, 'focus_ranges')
      || (
        Array.isArray(candidate.focus_ranges)
        && candidate.focus_ranges.every((entry) => isExpandableSourceRange(entry))
      )
    )
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

function hasCachedExplainContextPackGovernance(value: Record<string, unknown>): boolean {
  const governance = value.governance
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) {
    return false
  }
  const mcpCall = (governance as Record<string, unknown>).mcp_call
  return !!mcpCall && typeof mcpCall === 'object' && !Array.isArray(mcpCall)
}

function isCachedExplainContextPackPayload(value: unknown): value is CachedExplainContextPackPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return candidate.task === 'explain'
    && typeof candidate.prompt === 'string'
    && typeof candidate.task_intent === 'string'
    && (!Object.hasOwn(candidate, 'expandable')
      || (Array.isArray(candidate.expandable)
        && candidate.expandable.every((entry) => isContextPackExpandableRef(entry))))
    && hasCachedExplainContextPackGovernance(candidate)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function selectedContextSourceFilesFromCachedExplainPayload(payload: CachedExplainContextPackPayload): string[] {
  const expandableFocusFiles = (payload.expandable ?? [])
    .flatMap((entry) => entry.follow_up.focus_files)
    .filter((sourceFile, index, all) => sourceFile.trim().length > 0 && all.indexOf(sourceFile) === index)
  if (expandableFocusFiles.length > 0) {
    return expandableFocusFiles
  }

  if (!isObjectRecord(payload.pack)) {
    return []
  }

  const pack = payload.pack
  const selection: {
    matched_nodes: RetrieveResult['matched_nodes']
    execution_slice?: NonNullable<RetrieveResult['execution_slice']>
    slice?: NonNullable<RetrieveResult['slice']>
  } = {
    matched_nodes: Array.isArray(pack.matched_nodes) ? pack.matched_nodes as RetrieveResult['matched_nodes'] : [],
  }
  if (isObjectRecord(pack.execution_slice)) {
    selection.execution_slice = pack.execution_slice as unknown as NonNullable<RetrieveResult['execution_slice']>
  }
  if (isObjectRecord(pack.slice)) {
    selection.slice = pack.slice as unknown as NonNullable<RetrieveResult['slice']>
  }
  return selectedContextSourceFilesFromRetrieveResult(selection as Pick<RetrieveResult, 'matched_nodes' | 'execution_slice' | 'slice'>)
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

function withContextPackGovernance<T extends Record<string, unknown>>(
  payload: T,
  input: {
    graphFreshness: GraphContextFreshness
    task: ContextPackTaskKind
    taskIntent: TaskContextPlan['evidence']['recipe_id']
    budget: number
    evidence: Pick<ReturnType<typeof buildMadarResponseEvidence>, 'agent_directive' | 'answerability' | 'coverage' | 'evidence_strength' | 'missing_phases' | 'pack_confidence' | 'recovery'>
    expandable: readonly ContextPackExpandableRef[]
    retrievalStrategy?: ContextPackRetrievalStrategy | null
    resolution?: ContextPackResolution
    cacheEligible: boolean
    cacheStatus: 'hit' | 'miss' | 'bypass'
    deltaSessionId?: string
  },
): T & { governance: ReturnType<typeof buildContextPackGovernanceReceipt> } {
  return {
    ...payload,
    governance: buildContextPackGovernanceReceipt({
      surface: 'mcp_context_pack',
      graphFreshness: input.graphFreshness,
      task: input.task,
      taskIntent: input.taskIntent,
      budget: input.budget,
      evidence: input.evidence,
      expandable: input.expandable,
      ...(input.retrievalStrategy ? { retrievalStrategy: input.retrievalStrategy } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      mcpCall: {
        cacheEligible: input.cacheEligible,
        cacheStatus: input.cacheStatus,
        ...(input.deltaSessionId ? { deltaSessionId: input.deltaSessionId } : {}),
      },
    }),
  }
}

function withUpdatedContextPackGovernanceFreshness<T extends Record<string, unknown>>(
  payload: T,
  graphFreshness: GraphContextFreshness,
): T {
  const governance = payload.governance
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) {
    return payload
  }

  return {
    ...payload,
    governance: {
      ...governance,
      graph_freshness: {
        status: graphFreshness.status,
        graph_path: graphFreshness.graph_path,
        graph_version: graphFreshness.graph_version,
        graph_modified_ms: graphFreshness.graph_modified_ms,
        graph_modified_at: graphFreshness.graph_modified_at,
        generated_ms: graphFreshness.generated_ms,
        generated_at: graphFreshness.generated_at,
        madar_version: graphFreshness.madar_version,
        indexed_file_count: graphFreshness.indexed_file_count,
        changed_source_count: graphFreshness.changed_source_count,
        missing_source_count: graphFreshness.missing_source_count,
        selected_context_status: graphFreshness.selected_context_status,
        selected_context_file_count: graphFreshness.selected_context_file_count,
        changed_selected_context_count: graphFreshness.changed_selected_context_count,
        missing_selected_context_count: graphFreshness.missing_selected_context_count,
        changed_outside_selected_context_count: graphFreshness.changed_outside_selected_context_count,
        recommendation: graphFreshness.recommendation,
      },
    },
  }
}

function withUpdatedContextPackGovernanceCacheStatus<T extends Record<string, unknown>>(
  payload: T,
  cacheStatus: 'hit' | 'miss',
): T {
  const governance = payload.governance
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) {
    return payload
  }
  const mcpCall = (governance as Record<string, unknown>).mcp_call
  if (!mcpCall || typeof mcpCall !== 'object' || Array.isArray(mcpCall)) {
    return payload
  }
  return {
    ...payload,
    governance: {
      ...governance,
      mcp_call: {
        ...mcpCall,
        cache_status: cacheStatus,
      },
    },
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

function evidenceForRetrievePayload(
  payload: Partial<Pick<
    RetrieveResult,
    | 'coverage'
    | 'answer_contract'
    | 'execution_slice'
    | 'expandable'
    | 'question'
    | 'recovery'
    | 'task_contract'
  >> & {
    matched_nodes?: ReadonlyArray<{ label: string; source_file: string; snippet?: string | null }>
    relationships?: readonly unknown[]
  },
  graphPath: string,
  graph?: KnowledgeGraph,
) {
  const matchedNodes = payload.matched_nodes ?? []
  const relationships = payload.relationships ?? []
  const coveredWorkflowOwners = collectWorkflowOwners(matchedNodes.map((node) => node.source_file))
  const evidencePlan = buildRetrievalEvidencePlan({
    ...(payload.task_contract ? { taskContract: payload.task_contract } : {}),
    ...(payload.coverage ? { coverage: payload.coverage } : {}),
    ...(payload.expandable ? { expandable: payload.expandable } : {}),
    ...(payload.execution_slice ? { executionSlice: payload.execution_slice } : {}),
    ...(payload.answer_contract ? { answerContract: payload.answer_contract } : {}),
    missingPhases: missingPhasesFromPayload(payload),
    coveredWorkflowOwners,
    selectedNodeCount: matchedNodes.length,
    selectedRelationshipCount: relationships.length,
    ...(payload.question
      ? {
          question: payload.question,
          matchedNodes,
        }
      : {}),
  })
  return buildMadarResponseEvidence({
    evidencePlan,
    graph,
    graphPath,
    question: payload.question,
    recovery: payload.recovery,
  })
}

function evidenceForPathPayload(
  payload: Partial<Pick<RetrieveResult, 'coverage' | 'answer_contract' | 'execution_slice'>> & {
    relevant_files?: Array<{ path: string }>
    starter_files?: Array<{ path: string }>
    edit_steps?: Array<{ path: string }>
  },
  graphPath: string,
  question?: string,
  graph?: KnowledgeGraph,
) {
  return buildMadarResponseEvidence({
    answerContract: payload.answer_contract,
    coverage: payload.coverage,
    executionSlice: payload.execution_slice,
    graph,
    graphPath,
    question,
    missingPhases: missingPhasesFromPayload(payload),
    coveredWorkflowOwners: collectWorkflowOwners(
      (payload.relevant_files ?? []).map((entry) => entry.path),
      (payload.starter_files ?? []).map((entry) => entry.path),
      (payload.edit_steps ?? []).map((entry) => entry.path),
    ),
  })
}

function evidenceForImpactPayload(payload: {
  target_file?: string
  affected_files?: string[]
  direct_dependents?: Array<{ source_file: string }>
  transitive_dependents?: Array<{ source_file: string }>
}, graphPath: string, question?: string, graph?: KnowledgeGraph) {
  return buildMadarResponseEvidence({
    graph,
    graphPath,
    question,
    coveredWorkflowOwners: collectWorkflowOwners(
      payload.target_file ? [payload.target_file] : [],
      payload.affected_files ?? [],
      (payload.direct_dependents ?? []).map((entry) => entry.source_file),
      (payload.transitive_dependents ?? []).map((entry) => entry.source_file),
    ),
  })
}

function evidenceForGraphSummaryPayload(payload: {
  entrypoints?: Array<{ source_file: string }>
}, graphPath: string, graph?: KnowledgeGraph) {
  return buildMadarResponseEvidence({
    graph,
    graphPath,
    coveredWorkflowOwners: collectWorkflowOwners((payload.entrypoints ?? []).map((entry) => entry.source_file)),
  })
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

function snippetSourcePathCandidates(graphPath: string, sourceFile: string, projectRoot?: string): string[] {
  if (sourceFile.trim().length === 0) {
    return []
  }

  const graphDir = dirname(graphPath)
  const legacyProjectDir = basename(graphDir) === 'out' ? dirname(graphDir) : graphDir
  const roots = [...new Set([graphDir, projectRoot ?? legacyProjectDir].map((root) => resolve(root)))]
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
  options: { derived?: boolean; fileCache?: Map<string, string[] | null>; projectRoot?: string } = {},
): string | null {
  for (const candidatePath of snippetSourcePathCandidates(graphPath, sourceFile, options.projectRoot)) {
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
  task: ContextPackTaskKind,
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
  task: ContextPackTaskKind,
  taskIntent: TaskContextPlan['evidence']['recipe_id'],
  expandable: readonly ContextPackExpandableRef[],
  helpers: ToolHelpers,
  authorizedHandleIds?: ReadonlySet<string>,
): void {
  // Strict mode exposes context_expand only as a bounded verification path.
  // Do not make handles available merely because a pre-serialization pack
  // happened to contain them: serialization can promote a response to ready.
  if (helpers.strictContextPackMode && authorizedHandleIds === undefined) {
    return
  }
  for (const entry of expandable) {
    if (helpers.strictContextPackMode && !authorizedHandleIds?.has(entry.handle_id)) {
      continue
    }
    helpers.setContextPackHandle(entry.handle_id, {
      prompt,
      task,
      task_intent: taskIntent,
      follow_up: {
        ...entry.follow_up,
        focus_ranges: entry.follow_up.focus_ranges ?? [],
      },
    } satisfies StoredContextPackHandle)
  }
}

const STRICT_VERIFICATION_HANDLE_ID = 'strict-verify-target'

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}

function sourceRanges(value: unknown): ContextPackExpandableFollowUp['focus_ranges'] {
  return Array.isArray(value)
    ? value.filter(isExpandableSourceRange)
    : []
}

function strictPayloadExpandableEntries(payload: Record<string, unknown>): ContextPackExpandableRef[] {
  const pack = isObjectRecord(payload.pack) ? payload.pack : null
  const entries = [...(Array.isArray(payload.expandable) ? payload.expandable : []), ...(Array.isArray(pack?.expandable) ? pack.expandable : [])]
  const byHandle = new Map<string, ContextPackExpandableRef>()
  for (const entry of entries) {
    if (isContextPackExpandableRef(entry)) {
      byHandle.set(entry.handle_id, entry)
    }
  }
  return [...byHandle.values()]
}

interface StrictVerificationAuthorization {
  entry: ContextPackExpandableRef
  target: Record<string, unknown>
}

function strictVerificationAuthorization(payload: Record<string, unknown>): StrictVerificationAuthorization | null {
  const evidence = isObjectRecord(payload.evidence) ? payload.evidence : null
  const answerability = evidence && isObjectRecord(evidence.answerability) ? evidence.answerability : null
  if (!answerability || answerability.state !== 'verify_targets') {
    return null
  }

  const entries = strictPayloadExpandableEntries(payload)
  const candidate = Array.isArray(answerability.verification_targets)
    ? answerability.verification_targets.find(isObjectRecord) ?? null
    : null
  const requestedHandleId = typeof candidate?.handle_id === 'string' && candidate.handle_id.length > 0
    ? candidate.handle_id
    : null
  const candidateFocusFiles = stringValues(candidate?.focus_files)
  const candidateEvidenceClass = isContextPackEvidenceClass(candidate?.evidence_class)
    ? candidate.evidence_class
    : 'supporting'
  const matchingEntry = requestedHandleId
    ? entries.find((entry) => entry.handle_id === requestedHandleId)
    : entries.find((entry) => (
      candidateFocusFiles.some((file) => entry.follow_up.focus_files.includes(file))
      && entry.evidence_class === candidateEvidenceClass
    ))
  const entry = matchingEntry ?? (() => {
    const focusFiles = candidateFocusFiles.length > 0
      ? candidateFocusFiles
      : entries[0]?.follow_up.focus_files ?? []
    if (focusFiles.length === 0) {
      return null
    }
    const evidenceClass = candidateEvidenceClass
    return {
      kind: 'nodes' as const,
      handle_id: requestedHandleId ?? STRICT_VERIFICATION_HANDLE_ID,
      evidence_class: evidenceClass,
      count: focusFiles.length,
      preview: [],
      follow_up: {
        kind: 'context_pack' as const,
        task_kind: isContextPackTaskKind(payload.task) ? payload.task : 'explain',
        evidence_class: evidenceClass,
        focus_files: focusFiles,
        focus_ranges: sourceRanges(candidate?.focus_ranges),
      },
    } satisfies ContextPackExpandableRef
  })()
  if (!entry || entry.follow_up.focus_files.length === 0) {
    return null
  }

  const focusFiles = entry.follow_up.focus_files.slice(0, 5)
  const focusRanges = entry.follow_up.focus_ranges
    .filter((range) => sourceFileMatchesFocus(range.source_file, focusFiles))
    .slice(0, 5)
  const authorizedEntry: ContextPackExpandableRef = {
    ...entry,
    follow_up: {
      ...entry.follow_up,
      focus_files: focusFiles,
      focus_ranges: focusRanges,
    },
  }

  return {
    entry: authorizedEntry,
    target: {
      handle_id: authorizedEntry.handle_id,
      evidence_class: authorizedEntry.evidence_class,
      focus_files: focusFiles,
      focus_ranges: focusRanges,
      reason: typeof candidate?.reason === 'string' && candidate.reason.length > 0
        ? candidate.reason
        : `verify evidence:${authorizedEntry.evidence_class}`,
    },
  }
}

function strictVerificationHandleIds(payload: unknown): Set<string> {
  if (!isObjectRecord(payload)) {
    return new Set<string>()
  }
  const authorization = strictVerificationAuthorization(payload)
  return authorization ? new Set([authorization.entry.handle_id]) : new Set<string>()
}

export function constrainStrictContextPackPayload<T extends Record<string, unknown>>(
  payload: T,
  helpers: Pick<ToolHelpers, 'strictContextPackMode'>,
): T {
  if (!helpers.strictContextPackMode) {
    return payload
  }

  const mutablePayload = payload as Record<string, unknown>
  const evidence = isObjectRecord(mutablePayload.evidence) ? mutablePayload.evidence : null
  const answerability = evidence && isObjectRecord(evidence.answerability)
    ? evidence.answerability
    : null
  const pack = isObjectRecord(mutablePayload.pack) ? mutablePayload.pack : null
  const authorization = strictVerificationAuthorization(mutablePayload)
  const handleIds = authorization ? new Set([authorization.entry.handle_id]) : new Set<string>()
  const retainedExpandable = authorization ? [authorization.entry] : []

  if (answerability?.state === 'verify_targets' && authorization) {
    // Strict mode grants a single server-owned expansion. Normalize fallback
    // file targets into the same handle-backed shape as ordinary expandable
    // evidence, so every visible verify_targets result is actually callable.
    answerability.verification_targets = [authorization.target]
  } else if (answerability?.state === 'verify_targets') {
    // Do not leave an impossible instruction behind if no safe focus could be
    // constructed from server-generated evidence.
    answerability.state = 'insufficient'
    answerability.verification_targets = []
    answerability.broad_search_fallback = answerability.broad_search_fallback === 'blocked'
      ? 'blocked'
      : 'allowed'
    const caveats = stringValues(answerability.caveats)
    const caveat = 'strict profile could not authorize a bounded verification target'
    answerability.caveats = caveats.includes(caveat) ? caveats : [...caveats, caveat]
    if (evidence) {
      evidence.pack_confidence = 'low'
      evidence.agent_directive = 'explore_with_caution'
    }
  }

  if (retainedExpandable.length > 0) {
    mutablePayload.expandable = retainedExpandable
    if (pack) {
      pack.expandable = retainedExpandable
    }
  } else {
    delete mutablePayload.expandable
    if (pack) {
      delete pack.expandable
    }
  }

  const governance = isObjectRecord(mutablePayload.governance) ? mutablePayload.governance : null
  const directive = governance && isObjectRecord(governance.directive)
    ? governance.directive
    : null
  if (directive) {
    if (answerability) {
      directive.answerability = answerability.state
      directive.missing_obligation_count = stringValues(answerability.missing_obligations).length
    }
    if (evidence) {
      directive.pack_confidence = evidence.pack_confidence
      directive.agent_directive = evidence.agent_directive
    }
    directive.verification_target_count = handleIds.size
  }
  if (governance && isObjectRecord(governance.follow_up)) {
    if (retainedExpandable.length === 0) {
      delete governance.follow_up
    } else {
      governance.follow_up = {
        expandable_handle_count: retainedExpandable.length,
        expandable_evidence_classes: [...new Set(retainedExpandable.map((entry) => entry.evidence_class))],
        expansion_task_kinds: [...new Set(retainedExpandable.map((entry) => entry.follow_up.task_kind))],
        preview_item_count: retainedExpandable.reduce((total, entry) => total + entry.preview.length, 0),
        focus_file_count: retainedExpandable.reduce((total, entry) => total + entry.follow_up.focus_files.length, 0),
        focus_range_count: retainedExpandable.reduce((total, entry) => total + entry.follow_up.focus_ranges.length, 0),
      }
    }
  }

  return payload
}

function constrainStrictContextExpansionPayload<T extends Record<string, unknown>>(
  payload: T,
  helpers: Pick<ToolHelpers, 'strictContextPackMode'>,
): T {
  if (!helpers.strictContextPackMode) {
    return payload
  }

  const mutablePayload = payload as Record<string, unknown>
  const evidence = isObjectRecord(mutablePayload.evidence) ? mutablePayload.evidence : null
  const answerability = evidence && isObjectRecord(evidence.answerability)
    ? evidence.answerability
    : null
  const pack = isObjectRecord(mutablePayload.pack) ? mutablePayload.pack : null

  // A strict expansion consumes the only server-authorized verification
  // attempt. Never return a newly generated expandable/verify_targets loop:
  // its handles are deliberately not stored, so advertising them would make
  // the response instruct an agent to issue a guaranteed-to-fail call.
  delete mutablePayload.expandable
  delete mutablePayload.handle_id
  if (pack) {
    delete pack.expandable
  }

  if (answerability && (answerability.state === 'verify_targets' || answerability.state === 'insufficient')) {
    answerability.state = 'insufficient'
    answerability.verification_targets = []
    answerability.broad_search_fallback = 'blocked'
    const caveats = stringValues(answerability.caveats)
    const caveat = 'strict verification expansion limit reached; remaining targets were not authorized'
    answerability.caveats = caveats.includes(caveat) ? caveats : [...caveats, caveat]
    if (evidence) {
      evidence.pack_confidence = 'low'
      // The strict expansion cap deliberately blocks source probing. Preserve
      // the selected evidence and tell the agent to report its remaining
      // uncertainty from that evidence instead of treating a low confidence
      // label as permission to restart discovery.
      evidence.agent_directive = 'answer_from_pack'
    }
  } else if (answerability && Array.isArray(answerability.verification_targets)) {
    answerability.verification_targets = []
  }

  return payload
}

function storeFinalContextPackHandles(
  prompt: string,
  task: ContextPackTaskKind,
  taskIntent: TaskContextPlan['evidence']['recipe_id'],
  expandable: readonly ContextPackExpandableRef[],
  responsePayload: unknown,
  helpers: ToolHelpers,
): void {
  // A successful strict pack starts the next task boundary. Do this at the
  // commit point rather than at request entry: rejected input or freshness
  // validation must not revoke the prior pack's authorized verification.
  if (helpers.strictContextPackMode) {
    helpers.clearContextPackHandles()
  }
  const finalExpandable = helpers.strictContextPackMode && isObjectRecord(responsePayload)
    ? strictPayloadExpandableEntries(responsePayload)
    : expandable
  storeExpandableHandles(
    prompt,
    task,
    taskIntent,
    finalExpandable,
    helpers,
    helpers.strictContextPackMode ? strictVerificationHandleIds(responsePayload) : undefined,
  )
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
    ...helpers.readStoredCommunityLabels(graphPath, graph),
  }
  const focusFiles = stored.follow_up.focus_files
  const focusRanges = stored.follow_up.focus_ranges ?? []
  const nodeCandidates: Array<ContextPackNodeCandidate<ContextPackNode>> = []
  const communityIds = new Set<number>()
  const includedIds = new Set<string>()
  const snippetFileCache = new Map<string, string[] | null>()
  const projectRoot = resolveGraphSourceRoot(graphPath, graph)

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
          projectRoot,
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

  const compactRetrieval = compactRetrieveResult(retrieval)
  return {
    ...contextPackBasePayload(stored.task, stored.prompt, budget, graphPath, plan),
    handle_id: handleId,
    pack: compactRetrieval,
    matched_focus: nodeCandidates.length,
    ...metadata,
    evidence: evidenceForRetrievePayload({
      ...retrieval,
      matched_nodes: compactRetrieval.matched_nodes,
      relationships: compactRetrieval.relationships,
    }, graphPath, graph),
  }
}

export function handleToolCall(id: string | number | null, graphPath: string, params: unknown, helpers: ToolHelpers): StdioResponse | Promise<StdioResponse> {
  const toolName = helpers.stringParam(params, 'name')
  if (!toolName) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `tools/call requires a string name parameter <= ${helpers.maxStdioTextLength} characters`)
  }

  const toolArguments = helpers.recordParam(params, 'arguments') ?? {}
  const graphReceipt = helpers.loadGraphReceiptCached(graphPath)
  const graph = graphReceipt.graph
  const knownGraphFreshness = graphFreshnessFromReceipt(graphReceipt)

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
      return helpers.ok(id, helpers.textToolResult(semanticAnomaliesSummary(graph, helpers.numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 5)))
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
    case 'graph_summary': {
      const summary = buildGraphSummary(graph)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...summary,
        evidence: evidenceForGraphSummaryPayload(summary, graphPath, graph),
      })))
    }
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
      const detailLabels = { ...buildCommunityLabels(graph, detailCommunities), ...helpers.readStoredCommunityLabels(graphPath, graph) }
      const details = communityDetailsAtZoom(graph, detailCommunities, detailLabels, detailCommunityId, zoom)
      if (!details) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown community: ${detailCommunityId}`)
      }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(details)))
    }
    case 'community_overview': {
      const overviewCommunities = communitiesFromGraph(graph)
      const overviewLabels = { ...buildCommunityLabels(graph, overviewCommunities), ...helpers.readStoredCommunityLabels(graphPath, graph) }
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
      const communityLabels = helpers.readStoredCommunityLabels(graphPath, graph)
      const impactResult = analyzeImpact(graph, communityLabels, {
        label,
        ...(impactDepth !== null ? { depth: impactDepth } : {}),
        ...(edgeTypes && edgeTypes.length > 0 ? { edgeTypes } : {}),
      })
      const useVerboseImpact = toolArguments.verbose === true || toolArguments.compact === false
      const impactPayload = useVerboseImpact
        ? impactResult
        : {
            ...compactImpactResult(impactResult),
            missing_context: [],
          }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(
        {
          ...impactPayload,
          evidence: evidenceForImpactPayload(impactResult, graphPath, label, graph),
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
      const projectRoot = resolveGraphSourceRoot(validateGraphPath(graphPath), graph)
      const prResult = analyzePrImpact(graph, projectRoot, {
        ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
        ...(prDepth !== null ? { depth: prDepth } : {}),
        ...(prBudget !== null ? { budget: prBudget } : {}),
      })
      const useVerbosePrImpact = toolArguments.verbose === true || toolArguments.compact === false
      if (useVerbosePrImpact) {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify({
          ...prResult,
          evidence: buildMadarResponseEvidence({
            coverage: prResult.review_bundle.coverage,
            graph,
            graphPath,
            coveredWorkflowOwners: collectWorkflowOwners(prResult.changed_files),
          }),
        })))
      }
      const compactPrImpact = compactPrImpactResult(prResult)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...compactPrImpact,
        missing_context: (prResult.review_bundle.coverage ?? emptyCoverage()).missing_required,
        evidence: buildMadarResponseEvidence({
          coverage: prResult.review_bundle.coverage,
          graph,
          graphPath,
          coveredWorkflowOwners: collectWorkflowOwners(prResult.changed_files),
        }),
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
      const retrieveSnippetBudget = helpers.numberParamAlias(toolArguments, ['snippet_budget', 'snippetBudget'], { min: 0, max: helpers.maxStdioTokenBudget })
      if ((Object.hasOwn(toolArguments, 'snippet_budget') || Object.hasOwn(toolArguments, 'snippetBudget')) && retrieveSnippetBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `snippet_budget must be a number between 0 and ${helpers.maxStdioTokenBudget}`)
      }
      const retrieveTopNWithSnippet = helpers.numberParamAlias(toolArguments, ['top_n_with_snippet', 'topNWithSnippet'], { min: 0 })
      if ((Object.hasOwn(toolArguments, 'top_n_with_snippet') || Object.hasOwn(toolArguments, 'topNWithSnippet')) && retrieveTopNWithSnippet === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'top_n_with_snippet must be a non-negative number')
      }
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
      const retrieveSnippetOptions: RetrieveSnippetOptions = {
        ...(retrieveSnippetBudget !== null ? { snippetBudget: retrieveSnippetBudget } : {}),
        ...(retrieveTopNWithSnippet !== null ? { topNWithSnippet: retrieveTopNWithSnippet } : {}),
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
        projectRoot: resolveGraphSourceRoot(graphPath, graph),
      }) : Promise.resolve().then(() => retrieveContext(graph, {
        question,
        budget: retrieveBudget,
        ...(retrieveCommunity !== null ? { community: retrieveCommunity } : {}),
        ...(retrieveFileType ? { fileType: retrieveFileType } : {}),
        ...(retrieveLevelTyped !== null ? { retrievalLevel: retrieveLevelTyped } : {}),
        ...(retrieveStrategy ? { retrievalStrategy: retrieveStrategy } : {}),
      }))
      const useVerboseRetrieve = toolArguments.verbose === true || toolArguments.compact === false
      return retrieval.then((result) => {
        const retrievePlan = resolveTaskSelection(question, 'explain', { explicit: false })
        if (result.expandable && result.expandable.length > 0) {
          storeExpandableHandles(question, retrievePlan.task_kind, retrievePlan.task_intent, result.expandable, helpers)
        }
        const compactPayload = compactRetrieveResultForStdio(result, retrieveSnippetOptions)
        const payload = useVerboseRetrieve
          ? withRetrieveSnippetBudget(result, retrieveSnippetOptions)
          : {
              ...compactPayload,
              ...contextMetadata(compactPayload),
            }
        return helpers.ok(id, helpers.textToolResult(JSON.stringify({
          ...payload,
          evidence: evidenceForRetrievePayload(payload, graphPath, graph),
        })))
      }).catch((error: unknown) => {
        // A rejected retrieve (e.g. missing optional semantic dependency) must
        // surface as an MCP tool error the agent can read and react to —
        // never as an unhandled rejection that kills the server (#crash).
        const message = error instanceof Error ? error.message : 'retrieve failed'
        return helpers.ok(id, helpers.errorToolResult(message))
      })
    }
    case 'context_pack': {
      const prompt = helpers.stringParam(toolArguments, 'prompt')
      if (!prompt) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_pack requires a string prompt parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const rawTask = helpers.stringParam(toolArguments, 'task')
      if (rawTask !== null && !isContextPackTaskKind(rawTask)) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'task must be one of explain, implement, review, impact')
      }
      const resolvedTask = resolveTaskSelection(prompt, rawTask ?? 'explain', { explicit: rawTask !== null })
      const task = resolvedTask.task_kind
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
        task_intent: resolvedTask.task_intent,
      })
      const requireFreshGraphInput = Object.hasOwn(toolArguments, 'require_fresh_graph')
        ? toolArguments.require_fresh_graph
        : toolArguments.requireFreshGraph
      if (requireFreshGraphInput !== undefined && typeof requireFreshGraphInput !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'require_fresh_graph must be a boolean')
      }
      const requireFreshContextInput = Object.hasOwn(toolArguments, 'require_fresh_context')
        ? toolArguments.require_fresh_context
        : toolArguments.requireFreshContext
      if (requireFreshContextInput !== undefined && typeof requireFreshContextInput !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'require_fresh_context must be a boolean')
      }
      const initialGraphContextFreshness = analyzeGraphContextFreshness(graphPath, graph, undefined, knownGraphFreshness)
      if (requireFreshGraphInput === true) {
        try {
          requireFreshGraph(initialGraphContextFreshness, 'require_fresh_graph')
        } catch (error) {
          return helpers.failure(
            id,
            helpers.jsonrpcServerError,
            error instanceof Error ? error.message : 'require_fresh_graph refused non-fresh graph context',
          )
        }
      }

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
        ? knownGraphFreshness.graphVersion
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
            const cachedGraphFreshness = analyzeGraphContextFreshness(graphPath, graph, {
              selected_source_files: selectedContextSourceFilesFromCachedExplainPayload(cachedPayload),
            }, knownGraphFreshness)
            if (requireFreshContextInput === true) {
              try {
                requireFreshSelectedContext(cachedGraphFreshness, 'require_fresh_context')
              } catch (error) {
                return helpers.failure(
                  id,
                  helpers.jsonrpcServerError,
                  error instanceof Error ? error.message : 'require_fresh_context refused stale selected context',
                )
              }
            }
            const cachedWithFreshness = constrainStrictContextPackPayload(withUpdatedContextPackGovernanceFreshness(
              withUpdatedContextPackGovernanceCacheStatus(cachedPayload, 'hit'),
              cachedGraphFreshness,
            ), helpers)
            storeFinalContextPackHandles(
              cachedPayload.prompt,
              'explain',
              cachedPayload.task_intent,
              cachedPayload.expandable ?? [],
              cachedWithFreshness,
              helpers,
            )
            return helpers.ok(id, helpers.textToolResult(JSON.stringify(withContextPackCache(cachedWithFreshness, {
              status: 'hit',
              graph_version: cacheGraphVersion!,
            }))))
          } catch {
            helpers.clearContextPackCache(cacheKey)
          }
        }
      }

      if (task === 'review') {
        if (requireFreshContextInput === true) {
          return helpers.failure(id, helpers.jsonrpcInvalidParams, 'require_fresh_context is not supported for task=review')
        }
        const projectRoot = resolveGraphSourceRoot(validateGraphPath(graphPath), graph)
        const prResult = analyzePrImpact(graph, projectRoot, {
          budget: resolvedBudget,
          taskIntent: initialPlan.evidence.recipe_id,
        })
        const compactPack = compactPrImpactResult(prResult)
        const reviewMetadata = contextMetadata(prResult.review_bundle)
        const plan = buildTaskContextPlan({
          task_kind: 'review',
          prompt,
          budget: plannerBudget,
          task_intent: initialPlan.evidence.recipe_id,
          changed_paths: prResult.changed_files,
          focus_paths: [...prResult.review_context.supporting_paths, ...prResult.review_context.test_paths],
        })
        const evidence = buildMadarResponseEvidence({
          coverage: reviewMetadata.coverage,
          graph,
          graphPath,
          question: prompt,
          coveredWorkflowOwners: collectWorkflowOwners(
            prResult.changed_files,
            prResult.review_context.supporting_paths,
            prResult.review_context.test_paths,
          ),
        })
        const payload = constrainStrictContextPackPayload(withContextPackGovernance({
          ...contextPackBasePayload(task, prompt, resolvedBudget, graphPath, plan),
          pack: compactPack,
          ...reviewMetadata,
          evidence,
        }, {
          graphFreshness: initialGraphContextFreshness,
          task,
          taskIntent: initialPlan.evidence.recipe_id,
          budget: resolvedBudget,
          evidence,
          expandable: reviewMetadata.expandable,
          cacheEligible: false,
          cacheStatus: 'bypass',
        }), helpers)
        storeFinalContextPackHandles(
          prompt,
          task,
          initialPlan.evidence.recipe_id,
          reviewMetadata.expandable,
          payload,
          helpers,
        )
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(payload)))
      }

      const retrieval = retrieveContext(graph, {
        question: prompt,
        budget: resolvedBudget,
        taskKind: task,
        taskIntent: initialPlan.evidence.recipe_id,
        ...(contextPackLevelTyped !== null ? { retrievalLevel: contextPackLevelTyped } : {}),
        ...(contextPackStrategy ? { retrievalStrategy: contextPackStrategy } : {}),
      })
      const graphContextFreshness = analyzeGraphContextFreshness(graphPath, graph, {
        selected_source_files: selectedContextSourceFilesFromRetrieveResult(retrieval),
      }, knownGraphFreshness)
      if (requireFreshContextInput === true) {
        try {
          requireFreshSelectedContext(graphContextFreshness, 'require_fresh_context')
        } catch (error) {
          return helpers.failure(
            id,
            helpers.jsonrpcServerError,
            error instanceof Error ? error.message : 'require_fresh_context refused stale selected context',
          )
        }
      }

      if (task === 'impact') {
        const communityLabels = {
          ...buildCommunityLabels(graph, communitiesFromGraph(graph)),
          ...helpers.readStoredCommunityLabels(graphPath, graph),
        }
        const impactTarget = pickImpactTarget(retrieval)
        const impactResult = analyzeImpact(graph, communityLabels, {
          label: impactTarget,
          depth: 3,
        })
        const impactPack = compactImpactResult(impactResult)
        const metadata = impactMetadata(impactResult, resolvedBudget, prompt, initialPlan.evidence.recipe_id, contextPackLevelTyped ?? undefined)
        const evidence = buildMadarResponseEvidence({
          coverage: metadata.coverage,
          graph,
          graphPath,
          question: prompt,
          coveredWorkflowOwners: collectWorkflowOwners(
            impactResult.target_file ? [impactResult.target_file] : [],
            impactResult.affected_files ?? [],
          ),
        })
        const payload = constrainStrictContextPackPayload(withContextPackGovernance({
          ...contextPackBasePayload(task, prompt, resolvedBudget, graphPath, initialPlan),
          target: impactTarget,
          pack: impactPack,
          ...metadata,
          evidence,
        }, {
          graphFreshness: graphContextFreshness,
          task,
          taskIntent: initialPlan.evidence.recipe_id,
          budget: resolvedBudget,
          evidence,
          expandable: metadata.expandable,
          ...(contextPackStrategy ? { retrievalStrategy: contextPackStrategy } : {}),
          resolution,
          cacheEligible: false,
          cacheStatus: 'bypass',
        }), helpers)
        storeFinalContextPackHandles(
          prompt,
          task,
          initialPlan.evidence.recipe_id,
          metadata.expandable,
          payload,
          helpers,
        )
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(payload)))
      }

      const fullPack = contextPackFromRetrieveResult(retrieval)
      const compactPack = compactRetrieveResult(retrieval)
      const metadata = contextMetadata(retrieval)
      const implementation = task === 'implement'
        ? buildImplementationPackGuidance(graph, retrieval, {
            budget: resolvedBudget,
            taskIntent: initialPlan.evidence.recipe_id,
          })
        : undefined
      // Slice #78: emit context-pack quality diagnostics so callers can
      // detect bad runs (missing required evidence, zero claims, weak
      // retrieval, etc.) without re-implementing the heuristics.
      const diagnostics = computeContextPackDiagnostics(fullPack)
      const explainPayload = task === 'explain'
        ? buildExplainPackPayloadCore(compactPack, retrieval, implementation)
        : undefined

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
        const deltaRetrievalPlan = reconcileSurfaceRetrievalPlan(
          deltaResult.delta_pack.retrieval_plan,
          prompt,
          resolvedDeltaNodes.nodes,
        )
        const deltaEvidence = buildMadarResponseEvidence({
          answerContract: deltaResult.delta_pack.answer_contract,
          coverage: deltaResult.delta_pack.coverage,
          executionSlice: deltaResult.delta_pack.execution_slice,
          expandable: deltaResult.delta_pack.expandable,
          graph,
          graphPath,
          question: prompt,
          recovery: deltaResult.delta_pack.recovery,
          missingPhases: missingPhasesFromPayload(deltaResult.delta_pack),
          coveredWorkflowOwners: collectWorkflowOwners(resolvedDeltaNodes.nodes.map((node) => node.source_file)),
        })
        const deltaPayload = constrainStrictContextPackPayload(withContextPackGovernance({
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
            ...(deltaRetrievalPlan
              ? { retrieval_plan: deltaRetrievalPlan }
              : {}),
          },
          diagnostics: computeContextPackDiagnostics(deltaResult.delta_pack, { skipBudgetUnderutilization: true }),
          ...(includeSelectionDiagnostics && deltaResult.delta_pack.selection_diagnostics
            ? { selection_diagnostics: deltaResult.delta_pack.selection_diagnostics }
            : {}),
          ...(implementation ? { implementation } : {}),
          ...metadata,
          evidence: deltaEvidence,
        }, {
          graphFreshness: graphContextFreshness,
          task,
          taskIntent: initialPlan.evidence.recipe_id,
          budget: resolvedBudget,
          evidence: deltaEvidence,
          expandable: metadata.expandable,
          ...(contextPackStrategy ? { retrievalStrategy: contextPackStrategy } : {}),
          resolution,
          cacheEligible: false,
          cacheStatus: 'bypass',
          deltaSessionId,
        }), helpers)
        storeFinalContextPackHandles(
          prompt,
          task,
          initialPlan.evidence.recipe_id,
          metadata.expandable,
          deltaPayload,
          helpers,
        )
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(deltaPayload)))
      }
      const resolvedNodes = applyResolutionToNodes(compactPack.matched_nodes, compactPack.relationships)
      const retrievalPlan = reconcileSurfaceRetrievalPlan(
        (explainPayload?.pack ?? compactPack).retrieval_plan,
        prompt,
        resolvedNodes.nodes,
      )
      const serializedPack = {
        ...(explainPayload?.pack ?? compactPack),
        matched_nodes: resolvedNodes.nodes,
        ...(retrievalPlan ? { retrieval_plan: retrievalPlan } : {}),
      }
      const evidence = evidenceForRetrievePayload({
        question: prompt,
        ...(fullPack.task_contract ? { task_contract: fullPack.task_contract } : {}),
        ...(fullPack.coverage ? { coverage: fullPack.coverage } : {}),
        ...(fullPack.execution_slice ? { execution_slice: fullPack.execution_slice } : {}),
        ...(fullPack.answer_contract ? { answer_contract: fullPack.answer_contract } : {}),
        ...(fullPack.expandable ? { expandable: fullPack.expandable } : {}),
        ...(fullPack.recovery ? { recovery: fullPack.recovery } : {}),
        matched_nodes: resolvedNodes.nodes,
        relationships: serializedPack.relationships,
      }, graphPath, graph)
      const basePayload = withContextPackGovernance({
        ...contextPackBasePayload(task, prompt, resolvedBudget, graphPath, initialPlan),
        resolution,
        pack: serializedPack,
        ...(resolvedNodes.bytes_saved > 0
          ? { bytes_saved_by_resolution: resolvedNodes.bytes_saved, resolution_map: resolvedNodes.resolution_map }
          : {}),
        diagnostics,
        ...(includeSelectionDiagnostics && fullPack.selection_diagnostics
          ? { selection_diagnostics: fullPack.selection_diagnostics }
          : {}),
        ...(implementation ? { implementation } : {}),
        ...metadata,
        evidence,
      }, {
        graphFreshness: graphContextFreshness,
        task,
        taskIntent: initialPlan.evidence.recipe_id,
        budget: resolvedBudget,
        evidence,
        expandable: metadata.expandable,
        ...(contextPackStrategy ? { retrievalStrategy: contextPackStrategy } : {}),
        resolution,
        cacheEligible: cacheKey !== null && cacheGraphVersion !== null,
        cacheStatus: cacheKey && cacheGraphVersion ? 'miss' : 'bypass',
      })
      const unconstrainedResponsePayload = task === 'explain' && !includeSelectionDiagnostics
        ? buildAnswerReadyPackSchema(basePayload, resolvedBudget, fullPack.selection_diagnostics)
        : basePayload
      const responsePayload = constrainStrictContextPackPayload(unconstrainedResponsePayload, helpers)
      storeFinalContextPackHandles(
        prompt,
        task,
        initialPlan.evidence.recipe_id,
        metadata.expandable,
        responsePayload,
        helpers,
      )
      if (!cacheKey || !cacheGraphVersion) {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(responsePayload)))
      }
      const payloadText = JSON.stringify(withContextPackCache(responsePayload, {
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
      const stored = helpers.strictContextPackMode
        ? helpers.takeContextPackHandle(handleId)
        : helpers.getContextPackHandle(handleId)
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        const message = helpers.strictContextPackMode
          ? `Unknown or unauthorized context_pack handle_id '${handleId}'. Strict expansions must use one listed verification handle from the latest verify_targets pack.`
          : `Unknown context_pack handle_id '${handleId}'. Expand handles are only available within the MCP session that produced them.`
        return helpers.failure(id, helpers.jsonrpcInvalidParams, message)
      }
      if (!isStoredContextPackHandle(stored)) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Malformed context_pack handle_id '${handleId}'. Re-run context_pack and retry context_expand within the same MCP session.`)
      }
      if (helpers.strictContextPackMode) {
        // A strict pack authorizes one verification attempt total. Clearing
        // the remaining handles prevents a multi-target pack from becoming a
        // hidden graph-navigation loop.
        helpers.clearContextPackHandles()
      }

      const payload = constrainStrictContextExpansionPayload(buildFocusedExpansionPayload(
        graph,
        graphPath,
        handleId,
        stored,
        budget ?? 1500,
        helpers,
      ), helpers)
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
      const requireFreshGraphInput = Object.hasOwn(toolArguments, 'require_fresh_graph')
        ? toolArguments.require_fresh_graph
        : toolArguments.requireFreshGraph
      if (requireFreshGraphInput !== undefined && typeof requireFreshGraphInput !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'require_fresh_graph must be a boolean')
      }
      const requireFreshContextInput = Object.hasOwn(toolArguments, 'require_fresh_context')
        ? toolArguments.require_fresh_context
        : toolArguments.requireFreshContext
      if (requireFreshContextInput !== undefined && typeof requireFreshContextInput !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'require_fresh_context must be a boolean')
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
      const initialGraphFreshness = analyzeGraphContextFreshness(graphPath, graph, undefined, knownGraphFreshness)
      if (requireFreshGraphInput === true) {
        try {
          requireFreshGraph(initialGraphFreshness, 'require_fresh_graph')
        } catch (error) {
          return helpers.failure(
            id,
            helpers.jsonrpcServerError,
            error instanceof Error ? error.message : 'require_fresh_graph refused non-fresh graph context',
          )
        }
      }

      const retrieval = retrieveContext(graph, {
        question: prompt,
        budget: budget ?? 3000,
      })
      const graphFreshness = analyzeGraphContextFreshness(graphPath, graph, {
        selected_source_files: selectedContextSourceFilesFromRetrieveResult(retrieval),
      }, knownGraphFreshness)
      if (requireFreshContextInput === true) {
        try {
          requireFreshSelectedContext(graphFreshness, 'require_fresh_context')
        } catch (error) {
          return helpers.failure(
            id,
            helpers.jsonrpcServerError,
            error instanceof Error ? error.message : 'require_fresh_context refused stale selected context',
          )
        }
      }
      const previousSession =
        explicitSessionState
        ?? (sessionId ? helpers.getContextPromptSession(sessionId) : undefined)
      const promptPack = buildMadarPromptPack({
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
        graph_freshness: graphFreshness,
        compiled: provider === 'claude'
          ? {
              provider,
              format: 'session_payload',
              prompt: promptPack.session_payload,
              token_count: promptPack.token_count,
              session_payload_token_count: promptPack.session_payload_token_count,
              effective_token_count: promptPack.effective_token_count,
              reused_context_tokens: promptPack.reused_context_tokens,
              session_diagnostics: promptPack.session_diagnostics,
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
        evidence: evidenceForRetrievePayload(retrieval, graphPath, graph),
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
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...result,
        evidence: evidenceForPathPayload(result, graphPath, question, graph),
      })))
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
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...result,
        evidence: evidenceForPathPayload(result, graphPath, question, graph),
      })))
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
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...result,
        evidence: evidenceForPathPayload(result, graphPath, question, graph),
      })))
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
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...result,
        evidence: evidenceForPathPayload(result, graphPath, question, graph),
      })))
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
