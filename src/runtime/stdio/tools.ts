import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

import { buildMadarPromptPack } from '../../infrastructure/compare.js'
import { buildExplainPackPayloadCore } from '../../infrastructure/context-pack-command.js'
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
  SourceLexicalDefinitionContext,
} from '../../contracts/context-pack.js'
import type { ContextSessionState } from '../../contracts/context-session.js'
import { buildCommunityLabels } from '../../pipeline/community-naming.js'
import { communityDetailsAtZoom, communityDetailsMicro, type CommunityZoomLevel } from '../../pipeline/community-details.js'
import { lineNumberFromSourceLocation, lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { resolveGraphSourceRoot } from '../../shared/graph-source-root.js'
import { validateGraphPath } from '../../shared/security.js'
import { classifySourceDomain, isDiscoveryPathIgnored } from '../../shared/source-discovery.js'
import { sourceFunctionOccurrence } from '../../shared/source-function-occurrences.js'
import { featureMap } from '../feature-map.js'
import { implementationChecklist } from '../implementation-checklist.js'
import { buildExpandableRefs, classifyTaskContract, compileContextPack, estimateContextPackEntryTokens, type ContextPackNodeCandidate } from '../context-pack.js'
import type { RetrievalGateDecision } from '../../contracts/retrieval-gate.js'
import { classifyRetrievalLevel, extractPromptExclusions, retrievalSubjectPrompt } from '../retrieval-gate.js'
import { compileSourceExclusions } from '../source-exclusions.js'
import { reconcileSourceCalls, selectSourceDependencies, sourceCallsiteBundlesKey, sourceFunctionValueReferencesKey, sourceFlowCatalogKey, type SourceFlowCatalog, type SourceCallsiteBundle, type SourceFunctionValueReference } from '../retrieve/source-dependencies.js'
import { isPackageManifestPath, capturePackageSourceSnapshot, packageSourceSnapshotsMatch, type PackageSourceSnapshot } from '../../shared/package-manifest.js'
import { inspectSourceEvidencePath, readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationKind, sourceDeclarationQualifiedName, sourcePathForEvidence, sourceQueryLiterals } from '../retrieve/source-evidence.js'
import {
  getSourceModuleConfigurationSnapshot,
  sourceModuleConfigurationSnapshotIsFresh,
  type SourceModuleConfigurationSnapshot,
} from '../retrieve/source-modules.js'
import { pickImpactTargetIdentity } from '../context-pack-target.js'
import { analyzeImpact, callChains, compactImpactResult, ImpactTargetResolutionError, type ImpactResult } from '../impact.js'
import { analyzePrImpact, compactPrImpactResult } from '../pr-impact.js'
import { relevantFiles } from '../relevant-files.js'
import {
  collectRelationships,
  compactRetrieveResult,
  compactRetrieveResultForStdio,
  contextPackFromRetrieveResult,
  readSnippet,
  readQueryEvidenceSnippet,
  retrieveContext,
  retrieveContextAsync,
  sourceDiscoveryCoreKey,
  withRetrieveSnippetBudget,
  type RetrieveResult,
  type RetrieveSnippetOptions,
} from '../retrieve.js'
import { reconcileRetrievalPlanQueryEvidence } from '../retrieve/conceptual-fallback.js'
import { repositoryEvidenceQuestion } from '../retrieve/repository-query.js'
import { buildRetrievalEvidencePlan, tokenizeLabel } from '../retrieve/pipeline.js'
import { computeContextPackDiagnostics } from '../context-pack-diagnostics.js'
import { collectDeliveredContextReceipts, computeDeltaContextPack } from '../context-pack-delta.js'
import { compactSourceEvidenceNode, compactRepeatedSourceMetadata, compactContainedSourceReferences, omitSourceNavigationDetails, fitPreparedSourceEvidenceResponse, finalizeSourceEvidenceResponse as serializeSourceEvidenceResponse, MIN_SOURCE_EVIDENCE_BUDGET } from '../source-evidence-response.js'
import { prepareNestedSourceRefill } from '../source-nested-refill.js'
import { sourceDiagnosticQueries, sourceDiagnosticContextsKey } from '../retrieve/source-diagnostic-priority.js'
import {
  attachSourceContinuationHandles, createSourceContinuationPreparation, sourceValueConsumedCallees, sourceTypeRejectionCallees, sourceBracketedBranchCompletions,
  allocateSourceFlowBudget, type SourceFlowBudgetOptions,
  beginSourceContinuation,
  completeOverlappingSourceOwners,
  completeSourceExcerptGuards,
  completeSourceFunctionValueReferences,
  finalizeSourceCallsiteCompletion,
  expandSourceContinuation,
  isSourceContinuationHandle,
  sourceContinuationHandleId,
  type SourceContinuationHandle,
} from '../source-continuation.js'
import { sourceTypeRejectionQueryIdentifiers } from '../retrieve/source-excerpt-guards.js'
import { sourceCoherentContinuationCatalogKey, type SourceCoherentContinuationCatalog } from '../retrieve/source-coherent-continuation.js'
import { attachSourceGroupContinuation, expandSourceGroupContinuation, isSourceGroupContinuation } from '../source-group-continuation.js'
import { createSourceRecoveryPartition, filterSourceRecoveryResponse, restrictSourceRecoveryContinuation,
  verifySourceRecoveryPartition, type SourceRecoveryPartition } from '../source-recovery-partition.js'
import { sourceOutsideFileBudgetPreference } from '../source-container-budget.js'
import { protectSourceDiscoveryWitnesses, scopedSourceDeferralCore } from '../source-scoped-deferral.js'
import { parseExplicitSourceTargets, buildExplicitSourceTargetPayload, ExplicitSourceTargetError } from '../explicit-source-targets.js'
import { applySourceLexicalCaution, sourceLexicalDefinitionContext } from '../source-lexical-context.js'
import { resolveExplicitSourceCallees } from '../explicit-source-callees.js'
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
  graphFreshnessMetadata,
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
  estimateQueryTokens,
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

// Task prompts can contain requirements and output instructions; label-sized limits lose that context.
const MAX_CONTEXT_PACK_PROMPT_LENGTH = 32_768

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
  task: ContextPackTaskKind
  task_intent: TaskContextPlan['evidence']['recipe_id']
  follow_up: ContextPackExpandableFollowUp
  explicit_target?: { node_id: string; symbol: string }
  evidence_classes?: Record<string, ContextPackEvidenceClass>
  source_recovery_partition?: SourceRecoveryPartition
  /** Inherited caution only; never changes this handle's admitted owner scope. */
  lexical_definition_context?: SourceLexicalDefinitionContext
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

interface CachedExplainContextPackRecord {
  version: 1
  payload: CachedExplainContextPackPayload
  source_configuration: SourceModuleConfigurationSnapshot | null
  package_configuration: PackageSourceSnapshot | null
  source_flow_catalog?: SourceFlowCatalog
  source_coherent_continuation?: SourceCoherentContinuationCatalog
  source_callsites?: {
    source_dependencies: SourceCallsiteBundle['source_dependencies']
    bundles: Array<Omit<SourceCallsiteBundle, 'source_dependencies'>>
  }
  source_function_values?: {
    source_dependencies: SourceFunctionValueReference['source_dependencies']
    references: Array<Omit<SourceFunctionValueReference, 'source_dependencies'>>
  }
}

function cachedSourceFunctionValues(value: unknown): SourceFunctionValueReference[] {
  if (!isObjectRecord(value) || !Array.isArray(value.source_dependencies) || !Array.isArray(value.references)
    || value.source_dependencies.length > 32 || value.references.length > 4096) return []
  return value.references.filter(isObjectRecord).map(reference => ({ ...reference,
    source_dependencies: value.source_dependencies }) as SourceFunctionValueReference)
}

function cachedSourceCallsites(value: unknown): SourceCallsiteBundle[] {
  if (!isObjectRecord(value) || !Array.isArray(value.source_dependencies) || !Array.isArray(value.bundles)
    || value.source_dependencies.length > 32 || value.bundles.length > 4096) return []
  const dependencies = value.source_dependencies as SourceCallsiteBundle['source_dependencies']
  // This is process-local cache data. The completion helper revalidates every
  // source hash, range, path and policy before using it; malformed entries fall
  // back to the original response without adding or storing trial evidence.
  return value.bundles.filter(isObjectRecord).map(bundle => ({ ...bundle, source_dependencies: dependencies }) as SourceCallsiteBundle)
}

function cachedSourceFlowCatalog(value: unknown): SourceFlowCatalog | undefined {
  if (!isObjectRecord(value) || value.version !== 1 || !isObjectRecord(value.task_contract)) return undefined
  const task = value.task_contract
  if (task.task_kind !== 'explain'
    || !['required_evidence', 'preferred_evidence'].every(key => Array.isArray(task[key])
      && (task[key] as unknown[]).length <= 5
      && (task[key] as unknown[]).every(isContextPackEvidenceClass))) return undefined
  for (const key of ['callees', 'overflow']) {
    const entries = value[key]
    if (!Array.isArray(entries) || !entries.length || entries.length > 128) return undefined
    const ids = new Set<string>()
    for (const owner of entries) {
      if (!isObjectRecord(owner) || !['node_id', 'label', 'source_file'].every(field => typeof owner[field] === 'string'
        && String(owner[field]).length > 0 && String(owner[field]).length <= 4096)
        || !isObjectRecord(owner.range) || !Number.isSafeInteger(owner.range.start_line) || Number(owner.range.start_line) < 1
        || !Number.isSafeInteger(owner.range.end_line) || Number(owner.range.end_line) < Number(owner.range.start_line)
        || (key === 'overflow' && !isContextPackEvidenceClass(owner.evidence_class)) || ids.has(String(owner.node_id))) return undefined
      ids.add(String(owner.node_id))
    }
  }
  // The catalog is data-only; current source, policy and binding hashes are
  // independently authenticated by the allocator before any admission.
  return value as unknown as SourceFlowCatalog
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

function isExpandableNodeIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.length > 0)
    && new Set(value).size === value.length
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
  if (candidate.evidence_classes !== undefined
    && (!isObjectRecord(candidate.evidence_classes) || !Object.values(candidate.evidence_classes).every(isContextPackEvidenceClass))) return false
  if (candidate.lexical_definition_context !== undefined && !sourceLexicalDefinitionContext(candidate.lexical_definition_context)) return false

  if (candidate.explicit_target !== undefined
    && (!isObjectRecord(candidate.explicit_target) || typeof candidate.explicit_target.node_id !== 'string'
      || !candidate.explicit_target.node_id || typeof candidate.explicit_target.symbol !== 'string'
      || !candidate.explicit_target.symbol)) return false

  const followUp = candidate.follow_up as Record<string, unknown>
  return followUp.kind === 'context_pack'
    && isContextPackTaskKind(followUp.task_kind)
    && typeof followUp.evidence_class === 'string'
    && Array.isArray(followUp.focus_files)
    && (followUp.node_ids === undefined || isExpandableNodeIds(followUp.node_ids))
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

/** A code review may target existing source rather than the repository diff. */
function reviewTargetsChanges(prompt: string, args: Record<string, unknown>): boolean {
  if (['base_branch', 'baseBranch', 'head_branch', 'headBranch'].some(key => Object.hasOwn(args, key))) return true
  const signals = classifyRetrievalLevel({ prompt }).signals
  const positivePrompt = retrievalSubjectPrompt(extractPromptExclusions(prompt).positivePrompt)
  const references = [...signals.mentioned_paths, ...signals.mentioned_symbols,
    ...sourceQueryLiterals(positivePrompt).filter(value => /^[A-Za-z_$][\w$]*$/.test(value))]
  if (references.length === 0) return true
  // Code named `diff`, or a path such as src/commit.ts, is not Git intent.
  let prose = positivePrompt.replace(/`[^`\n]*`/g, ' ')
  for (const reference of references.filter(value => /[./\\#:(]/.test(value)).sort((a, b) => b.length - a.length)) {
    prose = prose.split(reference).join(' ')
  }
  return /\b(?:diffs?|pull\s+requests?|prs?|patch(?:es)?|commits?|staged|unstaged|uncommitted|working\s+tree)\b/i.test(prose)
    || /\b(?:review|audit|inspect|check|show|summarize)\s+(?:(?:the|my|our|these|current|recent|pending|local)\s+)*changes?\b/i.test(prose)
    || /\b(?:(?:current|recent|pending|local)\s+changes|changed\s+(?:files|code)|changes?\s+(?:since|between|against)|(?:base|head)\s+branch)\b/i.test(prose)
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
    && (candidate.node_ids === undefined || isExpandableNodeIds(candidate.node_ids))
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
    && (candidate.symbols === undefined || Array.isArray(candidate.symbols) && candidate.symbols.length <= 32
      && new Set(candidate.symbols).size === candidate.symbols.length
      && candidate.symbols.every(symbol => typeof symbol === 'string' && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(symbol)))
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
  if (!isObjectRecord(payload.pack)) {
    return expandableFocusFiles
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
  return [...new Set([
    ...selectedContextSourceFilesFromRetrieveResult(selection as Pick<RetrieveResult, 'matched_nodes' | 'execution_slice' | 'slice'>),
    ...expandableFocusFiles,
  ])]
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
) {
  return buildMadarResponseEvidence({
    answerContract: payload.answer_contract,
    coverage: payload.coverage,
    executionSlice: payload.execution_slice,
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
  traversal?: ImpactResult['traversal']
}, graphPath: string, question?: string) {
  return buildMadarResponseEvidence({
    graphPath,
    question,
    impactTraversal: payload.traversal,
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
}, graphPath: string) {
  return buildMadarResponseEvidence({
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
    node_id?: string
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
      ...(node.node_id !== undefined ? { node_id: node.node_id } : {}),
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
    ...(node.node_id !== undefined ? { node_id: node.node_id } : {}),
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
      ...(result.target_node_id !== undefined ? { node_id: result.target_node_id } : {}),
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
  evidenceClasses?: Record<string, ContextPackEvidenceClass>,
  lexicalContext?: SourceLexicalDefinitionContext,
): void {
  for (const entry of expandable) {
    // Stable navigation IDs may be reissued by a later ordinary pack. Keep an
    // existing caution without inheriting its owner scope or source authority.
    const previous = helpers.getContextPackHandle(entry.handle_id)
    const caution = lexicalContext ?? (isObjectRecord(previous)
      ? sourceLexicalDefinitionContext(previous.lexical_definition_context) : undefined)
    helpers.setContextPackHandle(entry.handle_id, {
      prompt,
      task,
      task_intent: taskIntent,
      ...(evidenceClasses ? { evidence_classes: evidenceClasses } : {}),
      ...(caution ? { lexical_definition_context: caution } : {}),
      follow_up: {
        ...entry.follow_up,
        focus_ranges: entry.follow_up.focus_ranges ?? [],
      },
    } satisfies StoredContextPackHandle)
  }
}

function payloadEvidenceClasses(payload: unknown): Record<string, ContextPackEvidenceClass> {
  if (!isObjectRecord(payload) || !isObjectRecord(payload.pack) || !Array.isArray(payload.pack.matched_nodes)) return {}
  return Object.fromEntries(payload.pack.matched_nodes.flatMap(node => {
    if (!isObjectRecord(node) || typeof node.node_id !== 'string') return []
    // compactRetrieveResult omits the duplicate class but retains the original
    // ranking band. These are the same role mappings used by retrieve packing.
    const evidenceClass = isContextPackEvidenceClass(node.evidence_class) ? node.evidence_class
      : node.relevance_band === 'direct' ? 'primary'
        : node.relevance_band === 'related' ? 'supporting'
          : node.relevance_band === 'peripheral' ? 'structural' : undefined
    return evidenceClass ? [[node.node_id, evidenceClass]] : []
  }))
}

function scopedFunctionValuePrompt(prompt: string): boolean {
  const paths = new Set(classifyRetrievalLevel({ prompt }).signals.mentioned_paths)
  return paths.size >= 2 && paths.size <= 8
}

/** A stored excerpt without a current source proof is not a recovery owner. */
function isolateUnverifiedSourceOwners(
  input: Record<string, unknown>, options: NonNullable<Parameters<typeof finalizeSourceEvidenceResponseLegacy>[2]>,
): Record<string, unknown> {
  const pack = isObjectRecord(input.pack) ? input.pack : {}, evidence = isObjectRecord(input.evidence) ? input.evidence : {}
  const answer = isObjectRecord(evidence.answerability) ? evidence.answerability : {}
  const governance = isObjectRecord(input.governance) ? input.governance : {}
  const freshness = isObjectRecord(governance.graph_freshness) ? governance.graph_freshness : {}
  if (!options.continuations || !options.requestedSource || options.verbose || options.format === 'text'
    || input.mode === 'delta' || input.delta_session_id || input.task !== 'explain' && input.task !== 'implement'
    || pack.selection_scope !== 'task_context' || pack.retrieval_strategy && pack.retrieval_strategy !== 'default'
    || pack.nodes !== undefined || pack.review_bundle !== undefined
    || freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh'
    || answer.broad_search_fallback === 'blocked'
    || !Array.isArray(pack.matched_nodes) || !pack.matched_nodes.length || pack.matched_nodes.length > 128
    || !pack.matched_nodes.every(isObjectRecord)) return input
  const nodes = pack.matched_nodes
  if (nodes.some(node => typeof node.node_id !== 'string' || !node.node_id)
    || new Set(nodes.map(node => node.node_id)).size !== nodes.length) return input
  const unverified = nodes.filter(node => node.snippet_unverified === true)
  if (!unverified.length) return input
  // Existing compaction can discard raw cursor fields. Do not let isolation
  // change a cursor-bearing packet's refusal before its normal proof path.
  if (nodes.some(node => node.source_expand_handle !== undefined)) return input
  // Only the explicit stored-snippet fallback shape is eligible. In particular,
  // do not hide an old cursor or a dependent's possible current-text mismatch.
  if (unverified.some(node => {
    const range = isObjectRecord(node.snippet_line_range) ? node.snippet_line_range : {}
    if (typeof node.snippet !== 'string' || !node.snippet.trim() || node.snippet_truncated !== true
      || typeof node.source_file !== 'string' || !node.source_file || typeof node.label !== 'string' || !node.label
      || node.snippet_scope !== undefined || node.snippet_source !== undefined || node.representation_type !== undefined
      || node.snippet_ref !== undefined || !Number.isSafeInteger(range.start_line) || !Number.isSafeInteger(range.end_line)
      || Number(range.start_line) < 1 || Number(range.end_line) < Number(range.start_line)
      || Object.keys(range).some(key => key !== 'start_line' && key !== 'end_line')) return true
    if (node.snippet_omitted_ranges === undefined) return false
    if (!Array.isArray(node.snippet_omitted_ranges) || node.snippet_omitted_ranges.length > 4096) return true
    let end = Number(range.start_line) - 1
    return node.snippet_omitted_ranges.some(gap => {
      if (!isObjectRecord(gap) || !Number.isSafeInteger(gap.start_line) || !Number.isSafeInteger(gap.end_line)
        || Number(gap.start_line) <= end || Number(gap.end_line) < Number(gap.start_line)
        || Number(gap.end_line) > Number(range.end_line)
        || Object.keys(gap).some(key => key !== 'start_line' && key !== 'end_line')) return true
      end = Number(gap.end_line)
      return false
    })
  })) return input
  const removed = new Set(unverified.map(node => node.node_id))
  if (nodes.some(node => typeof node.snippet_ref === 'string' && removed.has(node.snippet_ref))) return input
  const result = JSON.parse(JSON.stringify(input)) as Record<string, unknown>, nextPack = result.pack as Record<string, unknown>
  const retained = (nextPack.matched_nodes as Record<string, unknown>[]).filter(node => !removed.has(node.node_id))
  nextPack.matched_nodes = retained
  const removedLabels = new Set(unverified.map(node => node.label))
  if (Array.isArray(nextPack.relationships)) nextPack.relationships = nextPack.relationships.filter(value => {
    if (!isObjectRecord(value)) return true
    const incident = (id: unknown, label: unknown): boolean => typeof id === 'string'
      ? removed.has(id) : removedLabels.has(label)
    return !incident(value.from_id, value.from) && !incident(value.to_id, value.to)
  })
  for (const key of ['seed_nodes', 'changed_nodes', 'direct_dependents', 'transitive_dependents']) {
    if (Array.isArray(nextPack[key])) nextPack[key] = (nextPack[key] as unknown[]).filter(node =>
      !isObjectRecord(node) || !removed.has(node.node_id ?? node.id))
  }
  // A prior execution path is no longer supported as a whole. Keep its limits
  // and warnings, and preserve the answer contract's missing/do-not-claim facts.
  if (isObjectRecord(nextPack.execution_slice)) {
    const execution = nextPack.execution_slice
    nextPack.execution_slice = Object.fromEntries(['boundary_reason', 'missing_phases', 'gaps', 'omitted_branches']
      .filter(key => execution[key] !== undefined).map(key => [key, execution[key]]))
  }
  nextPack._unverified_source_omitted = unverified.length
  // Generic omission scopes remain owned navigation, not proof of these cached
  // bytes. No source cursor or session store is changed by this transformation.
  return result
}

/** Restore one selected scoped function value after the unchanged accepted stages. */
export function finalizeSourceEvidenceResponse(
  input: object, budget: number, options: Parameters<typeof finalizeSourceEvidenceResponseLegacy>[2] = {},
): Record<string, unknown> {
  if (isObjectRecord(input)) input = isolateUnverifiedSourceOwners(input, options)
  if (!options.continuations || !options.requestedSource || (!options.functionValues && !options.flowBudget)
    || !scopedFunctionValuePrompt(options.requestedSource.prompt)) return finalizeSourceEvidenceResponseBranches(input, budget, options)
  const handles = new Map<string, SourceContinuationHandle>()
  const baseline = finalizeSourceEvidenceResponseBranches(input, budget, { ...options,
    continuations: { ...options.continuations, store: (id, handle) => { handles.set(id, handle) } } })
  const record = (value: unknown): Record<string, unknown> => isObjectRecord(value) ? value : {}
  const pack = record(baseline.pack), rawPack = record(record(input).pack)
  const nodes = Array.isArray(pack.matched_nodes) ? pack.matched_nodes.filter(isObjectRecord) : []
  const commit = (payload: Record<string, unknown>, stored = handles): Record<string, unknown> => {
    if (options.flowBudget && options.callsites && options.requestedSource && options.continuations
      && !options.verbose && options.format !== 'text') {
      const allocation = allocateSourceFlowBudget(payload, record(input), budget, options.continuations.rootPath,
        options.requestedSource.prompt, options.callsites.bundles, options.flowBudget, stored,
        () => options.callsites!.configurationFresh() && (options.functionValues?.configurationFresh() ?? true), options.functionValues?.references ?? [])
      payload = allocation.payload; stored = allocation.handles
      for (const [id, handle] of allocation.generic) options.flowBudget.store(id, handle)
    }
    const advertised = new Set((Array.isArray(record(payload.pack).matched_nodes) ? record(payload.pack).matched_nodes as unknown[] : [])
      .flatMap(node => typeof record(node).source_expand_handle === 'string' ? [record(node).source_expand_handle] : []))
    for (const [id, handle] of stored) if (advertised.has(id)) options.continuations!.store(id, handle)
    return payload
  }
  if (!options.functionValues) return commit(baseline)
  const freshness = record(record(baseline.governance).graph_freshness)
  if (!options.requestedSource || options.verbose || options.format === 'text'
    || baseline.response_format !== 'source_evidence_v2' || baseline.task !== 'explain' || baseline.mode === 'delta' || baseline.delta_session_id
    || (rawPack.retrieval_strategy && rawPack.retrieval_strategy !== 'default') || pack.selection_scope !== 'task_context'
    || freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh'
    || record(record(baseline.evidence).answerability).broad_search_fallback === 'blocked'
    || !isObjectRecord(baseline.serialized_budget) || Object.keys(baseline.serialized_budget).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))
    || !nodes.length || nodes.length > 128
    || !Array.isArray(rawPack.matched_nodes) || rawPack.matched_nodes.length > 128 || !Array.isArray(pack.relationships)) return commit(baseline)
  const rootPath = options.continuations.rootPath
  const paths = classifyRetrievalLevel({ prompt: options.requestedSource.prompt }).signals.mentioned_paths
  if (paths.length < 2 || paths.length > 8) return commit(baseline)
  const omitted = record(baseline.omitted_evidence)
  if (omitted.reason !== 'output_budget' || !Number.isSafeInteger(omitted.count) || Number(omitted.count) <= 0
    || !Array.isArray(options.functionValues.references) || options.functionValues.references.length > 4096) return commit(baseline)
  const rawNodes = (rawPack.matched_nodes as unknown[]).map(record)
  const hasRawOwner = (target: Record<string, unknown>, range: Record<string, unknown>): boolean => {
    if (typeof target.node_id !== 'string' || typeof target.label !== 'string' || typeof target.source_file !== 'string'
      || !Number.isSafeInteger(range.start_line) || !Number.isSafeInteger(range.end_line)
      || Number(range.start_line) < 1 || Number(range.end_line) < Number(range.start_line)) return false
    const matches = rawNodes.filter(node => node.node_id === target.node_id), owner = matches.length === 1 ? matches[0] : undefined
    return !!owner && owner.label === target.label && typeof owner.source_file === 'string'
      && resolve(rootPath, owner.source_file) === resolve(rootPath, target.source_file)
      && record(owner.snippet_line_range).start_line === range.start_line
      && record(owner.snippet_line_range).end_line === range.end_line
  }
  // The raw compiled packet, rather than index membership, authorizes restoration.
  const references = options.functionValues.references.filter((reference: SourceFunctionValueReference) => {
    const target = record(record(reference).target)
    return !nodes.some(node => node.node_id === target.node_id) && hasRawOwner(target, record(target.range))
  })
  if (!references.length) return commit(baseline)
  const dependencies = new Map<string, { source_file: string; source_sha256: string }>()
  for (const sidecars of [options.callsites?.bundles ?? [], options.functionValues.references]) {
    if (!Array.isArray(sidecars) || sidecars.length > 4096) return commit(baseline)
    for (const sidecar of sidecars) {
      if (!sidecar || !Array.isArray(sidecar.source_dependencies) || !sidecar.source_dependencies.length || sidecar.source_dependencies.length > 32) return commit(baseline)
      for (const dependency of sidecar.source_dependencies) {
        if (!dependency || typeof dependency.source_file !== 'string' || !dependency.source_file
          || typeof dependency.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.source_sha256)) return commit(baseline)
        const path = resolve(rootPath, dependency.source_file), prior = dependencies.get(path)
        if (prior && prior.source_sha256 !== dependency.source_sha256) return commit(baseline)
        dependencies.set(path, dependency)
        if (dependencies.size > 32) return commit(baseline)
      }
    }
  }
  const prepare = createSourceContinuationPreparation(rootPath, id => handles.get(id),
    () => (options.callsites?.configurationFresh() ?? true) && options.functionValues!.configurationFresh(),
    { verifyAllSources: true, sourceDependencies: [...dependencies.values()] })
  const original = prepare(baseline)
  const refuse = (): Record<string, unknown> => fitPreparedSourceEvidenceResponse(baseline, budget,
    () => ({ ...original, refused: true })).payload
  if (original.refused || !original.validate()) return refuse()
  if (!original.valid) return commit(baseline)
  let referenceRefused = false
  const candidate = completeSourceFunctionValueReferences(baseline, budget, rootPath, options.requestedSource.prompt,
    references, id => handles.get(id), (id, handle) => { handles.set(id, handle) },
    () => original.validate(), { scoped: true, onVerificationFailure: () => { referenceRefused = true } })
  if (referenceRefused || !original.validate()) return refuse()
  if (candidate === baseline) return commit(baseline)
  const added = (Array.isArray(record(candidate.pack).matched_nodes) ? record(candidate.pack).matched_nodes as unknown[] : [])
    .map(record).filter(node => !nodes.some(prior => prior.node_id === node.node_id))
  if (added.length !== 1) return commit(baseline)
  const target = added[0]!
  if (!hasRawOwner(target, record(target.snippet_line_range))) return commit(baseline)
  candidate.omitted_evidence = { ...omitted, count: Number(omitted.count) - 1 }
  const fitted = fitPreparedSourceEvidenceResponse(candidate, budget, prepare)
  if (fitted.status === 'unverifiable' || !original.validate()) return refuse()
  if (fitted.status === 'fit' && fitted.preparation
    && estimateQueryTokens(JSON.stringify(fitted.payload)) <= estimateQueryTokens(JSON.stringify(baseline)) + 200) {
    if (!fitted.preparation.validate()) return refuse()
    return commit(fitted.payload, fitted.preparation.handles)
  }
  return commit(baseline)
}


/** One already bracketed branch completion after the unchanged accepted finalizer. */
function finalizeSourceEvidenceResponseBranches(
  input: object, budget: number, options: Parameters<typeof finalizeSourceEvidenceResponseLegacy>[2] = {},
): Record<string, unknown> {
  if (!options.continuations || !options.requestedSource) return finalizeSourceEvidenceResponseTypes(input, budget, options)
  const handles = new Map<string, SourceContinuationHandle>()
  const baseline = finalizeSourceEvidenceResponseTypes(input, budget, { ...options,
    continuations: { ...options.continuations, store: (id, handle) => { handles.set(id, handle) } } })
  const record = (value: unknown): Record<string, unknown> => isObjectRecord(value) ? value : {}
  const pack = record(baseline.pack), rawPack = record(record(input).pack)
  const nodes = Array.isArray(pack.matched_nodes) ? pack.matched_nodes.filter(isObjectRecord) : []
  const commit = (payload: Record<string, unknown>, stored = handles): Record<string, unknown> => {
    const advertised = new Set((Array.isArray(record(payload.pack).matched_nodes) ? record(payload.pack).matched_nodes as unknown[] : [])
      .flatMap(node => typeof record(node).source_expand_handle === 'string' ? [record(node).source_expand_handle] : []))
    for (const [id, handle] of stored) if (advertised.has(id)) options.continuations!.store(id, handle)
    return payload
  }
  const freshness = record(record(baseline.governance).graph_freshness)
  if (!options.requestedSource || !options.callsites || options.verbose || options.format === 'text'
    || baseline.response_format !== 'source_evidence_v2' || baseline.task !== 'explain' || baseline.mode === 'delta' || baseline.delta_session_id
    || (rawPack.retrieval_strategy && rawPack.retrieval_strategy !== 'default') || pack.selection_scope !== 'task_context'
    || freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh'
    || record(record(baseline.evidence).answerability).broad_search_fallback === 'blocked'
    || !isObjectRecord(baseline.serialized_budget) || Object.keys(baseline.serialized_budget).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))
    || record(baseline.omitted_evidence).reason !== 'output_budget' || !nodes.length || nodes.length > 128
    || !Array.isArray(rawPack.matched_nodes) || rawPack.matched_nodes.length > 128 || !Array.isArray(pack.relationships)) return commit(baseline)
  const omitted = record(baseline.omitted_evidence)
  if (!Number.isSafeInteger(omitted.count) || Number(omitted.count) < 0 || Number(omitted.count) >= Number.MAX_SAFE_INTEGER) return commit(baseline)
  const rootPath = options.continuations.rootPath
  const paths = classifyRetrievalLevel({ prompt: options.requestedSource.prompt }).signals.mentioned_paths
  if (paths.length < 2 || paths.length > 8) return commit(baseline)
  const dependencies = new Map<string, { source_file: string; source_sha256: string }>()
  for (const sidecars of [options.callsites.bundles, options.functionValues?.references ?? []]) {
    if (!Array.isArray(sidecars) || sidecars.length > 4096) return commit(baseline)
    for (const sidecar of sidecars) {
      if (!sidecar || !Array.isArray(sidecar.source_dependencies) || !sidecar.source_dependencies.length || sidecar.source_dependencies.length > 32) return commit(baseline)
      for (const dependency of sidecar.source_dependencies) {
        if (!dependency || typeof dependency.source_file !== 'string' || !dependency.source_file
          || typeof dependency.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.source_sha256)) return commit(baseline)
        const path = resolve(rootPath, dependency.source_file), prior = dependencies.get(path)
        if (prior && prior.source_sha256 !== dependency.source_sha256) return commit(baseline)
        dependencies.set(path, dependency)
        if (dependencies.size > 32) return commit(baseline)
      }
    }
  }
  const prepare = createSourceContinuationPreparation(rootPath, id => handles.get(id),
    () => options.callsites!.configurationFresh() && (options.functionValues?.configurationFresh() ?? true),
    { verifyAllSources: true, sourceDependencies: [...dependencies.values()] })
  const original = prepare(baseline)
  const refuse = (): Record<string, unknown> => fitPreparedSourceEvidenceResponse(baseline, budget,
    () => ({ ...original, refused: true })).payload
  if (original.refused || !original.validate()) return refuse()
  if (!original.valid) return commit(baseline)
  const selection = sourceBracketedBranchCompletions(baseline, rootPath, options.requestedSource.prompt)
  if (selection.refused || !selection.validate() || !original.validate()) return refuse()
  const victim = sourceOutsideFileBudgetPreference(options.requestedSource.prompt, rootPath, { ignoreProseOperators: true })(nodes, pack.relationships.map(record))
  if (!victim || selection.candidates.length !== 1) {
    if (!selection.validate() || !original.validate()) return refuse()
    return commit(baseline)
  }
  const baselineCost = estimateQueryTokens(JSON.stringify(baseline))
  for (const candidate of selection.candidates) {
    const trial = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>, trialPack = record(trial.pack)
    trialPack.matched_nodes = nodes.filter(node => node.node_id !== victim).map(node =>
      JSON.parse(JSON.stringify(node.node_id === candidate.node_id ? candidate : node)) as Record<string, unknown>)
    trial.omitted_evidence = { ...omitted, count: Number(omitted.count) + 1 }
    // The same owner gains source; no relationship is inferred. Baseline
    // authentication preceded removal of its old cursor, so preparation can
    // rebuild recovery for the smaller remaining omission set atomically.
    const fitted = fitPreparedSourceEvidenceResponse(trial, budget, prepare)
    if (fitted.status === 'unverifiable') return refuse()
    if (fitted.status !== 'fit' || !fitted.preparation || estimateQueryTokens(JSON.stringify(fitted.payload)) > baselineCost) continue
    if (!selection.validate() || !original.validate() || !fitted.preparation.validate()) return refuse()
    return commit(fitted.payload, fitted.preparation.handles)
  }
  if (!selection.validate() || !original.validate()) return refuse()
  return commit(baseline)
}


/** One local type-rejection unit after the unchanged accepted value finalizer. */
function finalizeSourceEvidenceResponseTypes(
  input: object, budget: number, options: Parameters<typeof finalizeSourceEvidenceResponseLegacy>[2] = {},
): Record<string, unknown> {
  if (!options.continuations || !options.requestedSource
    || !sourceTypeRejectionQueryIdentifiers(extractPromptExclusions(options.requestedSource.prompt).positivePrompt)) {
    return finalizeSourceEvidenceResponseValue(input, budget, options)
  }
  const handles = new Map<string, SourceContinuationHandle>()
  const baseline = finalizeSourceEvidenceResponseValue(input, budget, { ...options,
    continuations: { ...options.continuations, store: (id, handle) => { handles.set(id, handle) } } })
  const record = (value: unknown): Record<string, unknown> => isObjectRecord(value) ? value : {}
  const pack = record(baseline.pack), rawPack = record(record(input).pack)
  const nodes = Array.isArray(pack.matched_nodes) ? pack.matched_nodes.filter(isObjectRecord) : []
  const commit = (payload: Record<string, unknown>, stored = handles): Record<string, unknown> => {
    const advertised = new Set((Array.isArray(record(payload.pack).matched_nodes) ? record(payload.pack).matched_nodes as unknown[] : [])
      .flatMap(node => typeof record(node).source_expand_handle === 'string' ? [record(node).source_expand_handle] : []))
    for (const [id, handle] of stored) if (advertised.has(id)) options.continuations!.store(id, handle)
    return payload
  }
  const freshness = record(record(baseline.governance).graph_freshness)
  if (!options.requestedSource || !options.callsites || options.verbose || options.format === 'text'
    || baseline.response_format !== 'source_evidence_v2' || baseline.task !== 'explain' || baseline.mode === 'delta' || baseline.delta_session_id
    || (rawPack.retrieval_strategy && rawPack.retrieval_strategy !== 'default') || pack.selection_scope !== 'task_context'
    || freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh'
    || record(record(baseline.evidence).answerability).broad_search_fallback === 'blocked'
    || !isObjectRecord(baseline.serialized_budget) || Object.keys(baseline.serialized_budget).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))
    || record(baseline.omitted_evidence).reason !== 'output_budget' || !nodes.length || nodes.length > 128
    || !Array.isArray(rawPack.matched_nodes) || rawPack.matched_nodes.length > 128 || !Array.isArray(pack.relationships)) return commit(baseline)
  const rootPath = options.continuations.rootPath
  const paths = classifyRetrievalLevel({ prompt: options.requestedSource.prompt }).signals.mentioned_paths
  if (paths.length < 2 || paths.length > 8) return commit(baseline)
  const dependencies = new Map<string, { source_file: string; source_sha256: string }>()
  for (const sidecars of [options.callsites.bundles, options.functionValues?.references ?? []]) {
    if (!Array.isArray(sidecars) || sidecars.length > 4096) return commit(baseline)
    for (const sidecar of sidecars) {
      if (!sidecar || !Array.isArray(sidecar.source_dependencies) || !sidecar.source_dependencies.length || sidecar.source_dependencies.length > 32) return commit(baseline)
      for (const dependency of sidecar.source_dependencies) {
        if (!dependency || typeof dependency.source_file !== 'string' || !dependency.source_file
          || typeof dependency.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.source_sha256)) return commit(baseline)
        const path = resolve(rootPath, dependency.source_file), prior = dependencies.get(path)
        if (prior && prior.source_sha256 !== dependency.source_sha256) return commit(baseline)
        dependencies.set(path, dependency)
        if (dependencies.size > 32) return commit(baseline)
      }
    }
  }
  const prepare = createSourceContinuationPreparation(rootPath, id => handles.get(id),
    () => options.callsites!.configurationFresh() && (options.functionValues?.configurationFresh() ?? true),
    { verifyAllSources: true, sourceDependencies: [...dependencies.values()] })
  const original = prepare(baseline)
  const refuse = (): Record<string, unknown> => fitPreparedSourceEvidenceResponse(baseline, budget,
    () => ({ ...original, refused: true })).payload
  if (original.refused || !original.validate()) return refuse()
  if (!original.valid) return commit(baseline)
  const selection = sourceTypeRejectionCallees(baseline, record(input), rootPath, options.requestedSource.prompt, options.callsites.bundles)
  if (selection.refused || !selection.validate() || !original.validate()) return refuse()
  const victim = sourceOutsideFileBudgetPreference(options.requestedSource.prompt, rootPath)(nodes, pack.relationships.map(record))
  if (!victim || selection.candidates.length !== 1) {
    if (!selection.validate() || !original.validate()) return refuse()
    return commit(baseline)
  }
  const baselineCost = estimateQueryTokens(JSON.stringify(baseline))
  for (const candidate of selection.candidates) {
    const trial = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>, trialPack = record(trial.pack)
    trialPack.matched_nodes = [...nodes.filter(node => node.node_id !== victim).map(node => JSON.parse(JSON.stringify(node)) as Record<string, unknown>),
      compactSourceEvidenceNode(candidate.node)]
    trialPack.relationships = [...(pack.relationships as unknown[]), candidate.edge]
    // Only the complete outside victim leaves. The new partial owner and all
    // retained omissions are priced together with their authenticated recovery.
    const fitted = fitPreparedSourceEvidenceResponse(trial, budget, prepare)
    if (fitted.status === 'unverifiable') return refuse()
    if (fitted.status !== 'fit' || !fitted.preparation || estimateQueryTokens(JSON.stringify(fitted.payload)) > baselineCost) continue
    if (!selection.validate() || !original.validate() || !fitted.preparation.validate()) return refuse()
    return commit(fitted.payload, fitted.preparation.handles)
  }
  if (!selection.validate() || !original.validate()) return refuse()
  return commit(baseline)
}


/** One value-consumed implementation exchange after the unchanged legacy finalizer. */
function finalizeSourceEvidenceResponseValue(
  input: object, budget: number, options: Parameters<typeof finalizeSourceEvidenceResponseLegacy>[2] = {},
): Record<string, unknown> {
  if (!options.continuations) return finalizeSourceEvidenceResponseLegacy(input, budget, options)
  const handles = new Map<string, SourceContinuationHandle>()
  const baseline = finalizeSourceEvidenceResponseLegacy(input, budget, { ...options,
    continuations: { ...options.continuations, store: (id, handle) => { handles.set(id, handle) } } })
  const record = (value: unknown): Record<string, unknown> => isObjectRecord(value) ? value : {}
  const pack = record(baseline.pack), rawPack = record(record(input).pack)
  const nodes = Array.isArray(pack.matched_nodes) ? pack.matched_nodes.filter(isObjectRecord) : []
  const commit = (payload: Record<string, unknown>, stored = handles): Record<string, unknown> => {
    const advertised = new Set((Array.isArray(record(payload.pack).matched_nodes) ? record(payload.pack).matched_nodes as unknown[] : [])
      .flatMap(node => typeof record(node).source_expand_handle === 'string' ? [record(node).source_expand_handle] : []))
    for (const [id, handle] of stored) if (advertised.has(id)) options.continuations!.store(id, handle)
    return payload
  }
  const freshness = record(record(baseline.governance).graph_freshness)
  if (!options.requestedSource || !options.callsites || options.verbose || options.format === 'text'
    || baseline.response_format !== 'source_evidence_v2' || baseline.task !== 'explain' || baseline.mode === 'delta' || baseline.delta_session_id
    || (rawPack.retrieval_strategy && rawPack.retrieval_strategy !== 'default') || pack.selection_scope !== 'task_context'
    || freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh'
    || record(record(baseline.evidence).answerability).broad_search_fallback === 'blocked'
    || !isObjectRecord(baseline.serialized_budget) || Object.keys(baseline.serialized_budget).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))
    || record(baseline.omitted_evidence).reason !== 'output_budget' || !nodes.length || nodes.length > 128
    || !Array.isArray(rawPack.matched_nodes) || rawPack.matched_nodes.length > 128 || !Array.isArray(pack.relationships)) return commit(baseline)
  const rootPath = options.continuations.rootPath
  const paths = classifyRetrievalLevel({ prompt: options.requestedSource.prompt }).signals.mentioned_paths
  if (paths.length < 2 || paths.length > 8) return commit(baseline)
  const dependencies = new Map<string, { source_file: string; source_sha256: string }>()
  for (const sidecars of [options.callsites.bundles, options.functionValues?.references ?? []]) {
    if (!Array.isArray(sidecars) || sidecars.length > 4096) return commit(baseline)
    for (const sidecar of sidecars) {
      if (!sidecar || !Array.isArray(sidecar.source_dependencies) || !sidecar.source_dependencies.length || sidecar.source_dependencies.length > 32) return commit(baseline)
      for (const dependency of sidecar.source_dependencies) {
        if (!dependency || typeof dependency.source_file !== 'string' || !dependency.source_file
          || typeof dependency.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.source_sha256)) return commit(baseline)
        const path = resolve(rootPath, dependency.source_file), prior = dependencies.get(path)
        if (prior && prior.source_sha256 !== dependency.source_sha256) return commit(baseline)
        dependencies.set(path, dependency)
        if (dependencies.size > 32) return commit(baseline)
      }
    }
  }
  const prepare = createSourceContinuationPreparation(rootPath, id => handles.get(id),
    () => options.callsites!.configurationFresh() && (options.functionValues?.configurationFresh() ?? true),
    { verifyAllSources: true, sourceDependencies: [...dependencies.values()] })
  const original = prepare(baseline)
  const refuse = (): Record<string, unknown> => fitPreparedSourceEvidenceResponse(baseline, budget,
    () => ({ ...original, refused: true })).payload
  if (original.refused || !original.validate()) return refuse()
  if (!original.valid) return commit(baseline)
  const selection = sourceValueConsumedCallees(baseline, record(input), rootPath, options.requestedSource.prompt, options.callsites.bundles)
  if (selection.refused || !selection.validate() || !original.validate()) return refuse()
  const victim = sourceOutsideFileBudgetPreference(options.requestedSource.prompt, rootPath)(nodes, pack.relationships.map(record))
  if (!victim || !selection.candidates.length) {
    if (!selection.validate() || !original.validate()) return refuse()
    return commit(baseline)
  }
  const baselineCost = estimateQueryTokens(JSON.stringify(baseline))
  for (const candidate of selection.candidates) {
    const trial = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>, trialPack = record(trial.pack)
    trialPack.matched_nodes = [...nodes.filter(node => node.node_id !== victim).map(node => JSON.parse(JSON.stringify(node)) as Record<string, unknown>),
      compactSourceEvidenceNode(candidate.node)]
    trialPack.relationships = [...(pack.relationships as unknown[]), candidate.edge]
    // This complete, disconnected victim owns no cursor or reference supplier.
    // Every retained omission stays present; preparation subtracts newly delivered source from its pending cursor.
    const fitted = fitPreparedSourceEvidenceResponse(trial, budget, prepare)
    if (fitted.status === 'unverifiable') return refuse()
    if (fitted.status !== 'fit' || !fitted.preparation || estimateQueryTokens(JSON.stringify(fitted.payload)) >= baselineCost) continue
    if (!selection.validate() || !original.validate() || !fitted.preparation.validate()) return refuse()
    return commit(fitted.payload, fitted.preparation.handles)
  }
  if (!selection.validate() || !original.validate()) return refuse()
  return commit(baseline)
}

function finalizeSourceEvidenceResponseLegacy(
  input: object,
  budget: number,
  options: Parameters<typeof serializeSourceEvidenceResponse>[2] & {
    continuations?: { rootPath: string; store: (id: string, handle: SourceContinuationHandle) => void }
    callsites?: { bundles: readonly SourceCallsiteBundle[]; configurationFresh: () => boolean }
    functionValues?: { references: readonly SourceFunctionValueReference[]; configurationFresh: () => boolean }
    flowBudget?: SourceFlowBudgetOptions
  } = {},
): Record<string, unknown> {
  const originalPack = isObjectRecord(input) && isObjectRecord(input.pack) ? input.pack : {}
  const refill = options.continuations && options.requestedSource && !options.verbose && options.format !== 'text'
    && resolve(options.continuations.rootPath) === resolve(options.requestedSource.rootPath)
    ? prepareNestedSourceRefill(input, options.requestedSource) : undefined
  const scopedDiagnostics = options.requestedSource
    ? sourceDiagnosticQueries(options.requestedSource.prompt)[sourceDiagnosticContextsKey]?.some(Boolean) === true : false
  let staged = new Map<string, SourceContinuationHandle>()
  let verificationFailed = false
  const checkedFresh = (check: (() => boolean) | undefined): boolean => {
    try { if (check && !check()) verificationFailed = true } catch { verificationFailed = true }
    return !verificationFailed
  }
  const callsitesFresh = (): boolean => checkedFresh(() => options.callsites?.configurationFresh() ?? true)
  const valuesFresh = (): boolean => checkedFresh(() => options.functionValues?.configurationFresh() ?? true)
  // One proof cache retains every inspected identity, including files whose last
  // partial owner disappears from a later, smaller serialization attempt.
  let prepareSource: ReturnType<typeof createSourceContinuationPreparation> | undefined
  let latestProof: ReturnType<ReturnType<typeof createSourceContinuationPreparation>> | undefined
  let latestInput: Record<string, unknown> | undefined
  const prepare = (payload: Record<string, unknown>) => {
    prepareSource ??= createSourceContinuationPreparation(options.continuations!.rootPath,
      id => staged.get(id), () => callsitesFresh() && valuesFresh(),
      { verifyAllSources: !!refill || Number.isSafeInteger(originalPack._unverified_source_omitted) && Number(originalPack._unverified_source_omitted) > 0 })
    latestInput = payload
    latestProof = prepareSource(payload)
    return latestProof
  }
  const refuse = (): Record<string, unknown> => fitPreparedSourceEvidenceResponse(latestInput!, budget,
    () => ({ ...latestProof!, refused: true })).payload
  type Attempt = {
    payload: Record<string, unknown>
    handles: Map<string, SourceContinuationHandle>
    jointlyPriced: boolean
    overflow?: { requiredTokens: number; sourceTokens: number }
  }
  const attempt = (sourceBudget: number): Attempt => {
    // Preserve the baseline allocation while selected nested source is pending.
    // Optional navigation savings can fund that source after its first full fit.
    const payload = finalizeSourceEvidenceResponseCore(input, sourceBudget,
      refill || !scopedDiagnostics ? { ...options, deferNavigationDetails: true } : options)
    staged = new Map<string, SourceContinuationHandle>()
    const stage = (id: string, handle: SourceContinuationHandle): void => { staged.set(id, handle) }
    const finish = (completed: Record<string, unknown>): Attempt => {
      const completedOwners = options.requestedSource
        && !options.verbose && options.format !== 'text' && completed.task === 'explain'
        && completed.mode !== 'delta' && !completed.delta_session_id
        && (!originalPack.retrieval_strategy || originalPack.retrieval_strategy === 'default')
        ? completeOverlappingSourceOwners(compactRepeatedSourceMetadata(completed, sourceBudget), sourceBudget,
          options.requestedSource.rootPath, options.requestedSource.prompt) : completed
      const guarded = options.requestedSource && options.callsites && options.continuations
        && !options.verbose && options.format !== 'text'
        && (!originalPack.retrieval_strategy || originalPack.retrieval_strategy === 'default')
        ? completeSourceExcerptGuards(completedOwners, sourceBudget, options.requestedSource.rootPath, options.requestedSource.prompt,
          id => staged.get(id), stage, callsitesFresh) : completedOwners
      const referencedSource = options.requestedSource && options.functionValues && options.continuations
        && !scopedFunctionValuePrompt(options.requestedSource.prompt)
        && !options.verbose && options.format !== 'text'
        && (!originalPack.retrieval_strategy || originalPack.retrieval_strategy === 'default')
        ? completeSourceFunctionValueReferences(guarded, sourceBudget, options.requestedSource.rootPath, options.requestedSource.prompt,
          options.functionValues.references, id => staged.get(id), stage, valuesFresh) : guarded
      // Keep the earlier completion path unchanged. Only now price every retained
      // partial owner together with authenticated recovery and commit the final plan.
      const freshness = isObjectRecord(referencedSource.governance) && isObjectRecord(referencedSource.governance.graph_freshness)
        ? referencedSource.governance.graph_freshness : {}
      const evidence = isObjectRecord(referencedSource.evidence) ? referencedSource.evidence : {}
      const answerability = isObjectRecord(evidence.answerability) ? evidence.answerability : {}
      const jointRecovery = options.continuations && !options.verbose && options.format !== 'text'
        && referencedSource.response_format === 'source_evidence_v2' && (referencedSource.task === 'explain' || referencedSource.task === 'implement')
        && referencedSource.mode !== 'delta' && !referencedSource.delta_session_id
        && (!originalPack.retrieval_strategy || originalPack.retrieval_strategy === 'default')
        && isObjectRecord(referencedSource.pack) && referencedSource.pack.selection_scope === 'task_context'
        && freshness.status === 'fresh' && freshness.selected_context_status === 'fresh'
        && answerability.broad_search_fallback !== 'blocked'
        && isObjectRecord(referencedSource.serialized_budget)
        && Object.keys(referencedSource.serialized_budget).every(key => ['max_tokens', 'token_count', 'enforced'].includes(key))
      let result: Record<string, unknown>
      let accepted = staged
      let overflow: Attempt['overflow']
      if (jointRecovery && options.continuations) {
        const fitted = fitPreparedSourceEvidenceResponse(referencedSource, budget, prepare,
          options.requestedSource ? { requestedSource: options.requestedSource } : {})
        result = fitted.payload
        if (fitted.status === 'over_budget') overflow = fitted.overflow
        accepted = fitted.preparation?.handles ?? new Map()
      } else {
        result = options.continuations && !options.verbose && options.format !== 'text'
          ? attachSourceContinuationHandles(referencedSource, sourceBudget, options.continuations.rootPath, stage, id => staged.get(id))
          : referencedSource
      }
      return { payload: result, handles: accepted, jointlyPriced: !!jointRecovery, ...(overflow ? { overflow } : {}) }
    }
    if (options.callsites && options.continuations && !options.verbose) {
      const pack = isObjectRecord(input) && isObjectRecord(input.pack) ? input.pack : {}
      const allocation = options.requestedSource && options.format !== 'text'
        && (!pack.retrieval_strategy || pack.retrieval_strategy === 'default')
        ? { prompt: options.requestedSource.prompt } : undefined
      return finish(finalizeSourceCallsiteCompletion(payload, sourceBudget, options.continuations.rootPath,
        options.callsites.bundles, stage, callsitesFresh, allocation))
    }
    return finish(options.continuations && !options.verbose
      ? attachSourceContinuationHandles(payload, sourceBudget, options.continuations.rootPath, stage)
      : payload)
  }
  const commit = (value: Attempt): Record<string, unknown> => {
    if (refill && value.jointlyPriced && !value.overflow) {
      let trials = 0
      for (const node of refill.candidates) {
        if (trials === 4) break
        const trial = refill.trial(value.payload, node, id => value.handles.get(id))
        if (!trial) continue
        trials++
        // Reissued pointers belong to the accepted plan. Reuse its handles and
        // the original sticky proof cache; never publish a rejected trial.
        staged = new Map(value.handles)
        let fitted = fitPreparedSourceEvidenceResponse(trial, budget, prepare)
        if (fitted.status === 'over_budget') {
          // Retry this same candidate at most once, without changing accepted
          // owners or handles. Successful original fits keep their exact bytes.
          const compact = omitSourceNavigationDetails(trial)
          if (compact !== trial) fitted = fitPreparedSourceEvidenceResponse(compact, budget, prepare)
        }
        if (fitted.status === 'over_budget') continue
        // An unsupported optional declaration cannot invalidate accepted source.
        // Keep its inspected file in this cache for the final drift validation.
        if (fitted.status === 'unsupported' && latestProof?.refused === false
          && latestProof.rejectedNodeIds.length > 0 && latestProof.rejectedNodeIds.every(id => id === node.node_id)) continue
        if (fitted.status !== 'fit') return fitted.payload
        value = { payload: fitted.payload, handles: fitted.preparation!.handles, jointlyPriced: true }
      }
      if (trials && latestProof && !latestProof.validate()) return refuse()
    }
    const pack = isObjectRecord(value.payload.pack) ? value.payload.pack : {}
    const referenced = new Set((Array.isArray(pack.matched_nodes) ? pack.matched_nodes : [])
      .flatMap(node => isObjectRecord(node) && typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : []))
    // Failed attempts stay private; commit only pointers advertised by the winner.
    for (const [id, handle] of value.handles) if (referenced.has(id)) options.continuations?.store(id, handle)
    return value.payload
  }
  let sourceBudget = budget, fallback: Attempt | undefined
  for (let index = 0; index < 3; index++) {
    if (index > 0 && latestProof && !latestProof.validate()) return refuse()
    const candidate = attempt(sourceBudget)
    // A reduced source cap may leave only an insufficiency envelope. Keep the
    // original-cap refusal rather than expose a temporary allocation receipt.
    if (index > 0 && !candidate.jointlyPriced) {
      if (latestProof && !latestProof.validate()) return refuse()
      return commit(fallback!)
    }
    if (!candidate.overflow) return commit(candidate)
    fallback = candidate
    const { requiredTokens, sourceTokens } = candidate.overflow
    const overage = requiredTokens - budget
    const recovery = Math.max(0, requiredTokens - sourceTokens)
    const next = Math.min(sourceBudget - overage, budget - recovery)
    if (!Number.isSafeInteger(next) || next < MIN_SOURCE_EVIDENCE_BUDGET || next >= sourceBudget) break
    sourceBudget = next
  }
  return commit(fallback!)
}

/** A verification target must add source, not merely relabel complete files already delivered. */
function finalizeSourceEvidenceResponseCore(
  input: object,
  budget: number,
  options: Parameters<typeof serializeSourceEvidenceResponse>[2] = {},
): Record<string, unknown> {
  const payload = serializeSourceEvidenceResponse(input, budget, options)
  // Deferred scopes are stored in full; compact focus_files are only hints and
  // cannot prove that every source promised by their handles was delivered.
  if (isObjectRecord(input) && isObjectRecord(input.pack)
    && (input.pack._source_discovery_deferred === true || input.pack._explicit_source_targets === true)) return payload
  const pack = isObjectRecord(payload.pack) ? payload.pack : null
  const evidence = isObjectRecord(payload.evidence) ? payload.evidence : null
  const answerability = evidence && isObjectRecord(evidence.answerability) ? evidence.answerability : null
  const governance = isObjectRecord(payload.governance) ? payload.governance : null
  const freshness = governance && isObjectRecord(governance.graph_freshness) ? governance.graph_freshness : null
  if (!pack || !answerability || payload.mode === 'delta' || payload.delta_session_id
    || payload.omitted_evidence || payload.omitted_nodes
    || freshness?.status !== 'fresh' || freshness.selected_context_status !== 'fresh') return payload

  const fileIdentity = (file: string): string => {
    const normalized = file.replace(/\\/g, '/')
    return options.sourceRoot ? resolve(options.sourceRoot, normalized) : normalized
  }
  const completeFiles = new Set((Array.isArray(pack.matched_nodes) ? pack.matched_nodes : []).flatMap(node => (
    isObjectRecord(node) && node.snippet_file_complete === true && typeof node.source_file === 'string'
      && typeof node.snippet === 'string' && node.snippet_source !== 'derived' && node.snippet_unverified !== true
      && node.snippet_truncated !== true && (!Array.isArray(node.snippet_omitted_ranges) || node.snippet_omitted_ranges.length === 0)
      ? [fileIdentity(node.source_file)] : []
  )))
  const entirelyDelivered = (value: unknown): boolean => {
    if (!isObjectRecord(value)) return false
    const followUp = isObjectRecord(value.follow_up) ? value.follow_up : value
    const files = stringValues(followUp.focus_files)
    return files.length > 0 && files.every(file => completeFiles.has(fileIdentity(file)))
  }
  const removed = new Set<string>()
  let changed = false
  for (const owner of [payload, pack]) {
    if (!Array.isArray(owner.expandable) || owner.expandable.length === 0) continue
    const remaining = owner.expandable.filter(entry => {
      if (!entirelyDelivered(entry)) return true
      if (isObjectRecord(entry) && typeof entry.handle_id === 'string') removed.add(entry.handle_id)
      changed = true
      return false
    })
    if (remaining.length === 0) delete owner.expandable
    else owner.expandable = remaining
  }
  if (Array.isArray(answerability.verification_targets)) {
    answerability.verification_targets = answerability.verification_targets.filter(target => {
      const redundant = isObjectRecord(target)
        && ((typeof target.handle_id === 'string' && removed.has(target.handle_id)) || entirelyDelivered(target))
      if (redundant) changed = true
      return !redundant
    })
  }
  // Only navigation changed. Preserve all missing obligations and uncertainty,
  // and recount the exact final wire payload without adding or dropping source.
  return changed ? serializeSourceEvidenceResponse(payload, budget, { verbose: true }) : payload
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
  if (!candidate) return null
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
  // Class recovery is justified only by the existing owned class scope and its
  // still-missing obligation. It must never synthesize a broader file target.
  if (candidate.basis === 'evidence_class' && (!requestedHandleId || !matchingEntry
    || matchingEntry.evidence_class !== candidateEvidenceClass
    || candidate.obligation_id !== `evidence:${candidateEvidenceClass}`
    || !stringValues(answerability.missing_obligations).includes(candidate.obligation_id))) return null
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
      handle_id: requestedHandleId ?? `verify-${createHash('sha256').update(JSON.stringify([payload.prompt, payload.task, focusFiles, candidate?.focus_ranges])).digest('hex').slice(0, 16)}`,
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
      ...(candidate.basis === 'evidence_class'
        ? { basis: candidate.basis, obligation_id: candidate.obligation_id } : {}),
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
  // Profiles control tools, not authority to verify. Make server-owned file targets
  // callable while retaining all existing handles and allowing further focused reads.
  const authorization = strictVerificationAuthorization(payload)
  if (authorization) {
    const mutable = payload as Record<string, unknown>
    const entries = strictPayloadExpandableEntries(payload)
    if (!entries.some(entry => entry.handle_id === authorization.entry.handle_id)) entries.push(authorization.entry)
    mutable.expandable = entries
    const answerability = (mutable.evidence as { answerability: Record<string, unknown> }).answerability
    const targets = Array.isArray(answerability.verification_targets) ? answerability.verification_targets : []
    answerability.verification_targets = [authorization.target, ...targets.slice(1)]
  }
  return payload
}

function constrainStrictContextExpansionPayload<T extends Record<string, unknown>>(
  payload: T,
  _helpers: Pick<ToolHelpers, 'strictContextPackMode'>,
): T { return payload }

function storeFinalContextPackHandles(
  prompt: string,
  task: ContextPackTaskKind,
  taskIntent: TaskContextPlan['evidence']['recipe_id'],
  expandable: readonly ContextPackExpandableRef[],
  responsePayload: unknown,
  helpers: ToolHelpers,
): void {
  const entries = new Map(expandable.map(entry => [entry.handle_id, entry]))
  if (isObjectRecord(responsePayload)) {
    for (const entry of strictPayloadExpandableEntries(responsePayload)) {
      const original = entries.get(entry.handle_id)
      // Compact verification hints may shorten file/range lists. Keep the full
      // server-owned omission receipt rather than widen or truncate its scope.
      entries.set(entry.handle_id, original?.follow_up.node_ids !== undefined
        ? { ...entry, follow_up: original.follow_up } : entry)
    }
  }
  const lexicalContext = isObjectRecord(responsePayload) && isObjectRecord(responsePayload.pack)
    && isObjectRecord(responsePayload.pack.source_dependencies)
    ? sourceLexicalDefinitionContext(responsePayload.pack.source_dependencies.lexical_definition_context) : undefined
  storeExpandableHandles(prompt, task, taskIntent, [...entries.values()], helpers, payloadEvidenceClasses(responsePayload), lexicalContext)
}

/** Reissue immutable recovery scopes. The original handles remain valid for
 * their original response; no session-wide seen set or handle mutation is used. */
function partitionRecoveryReferences(
  input: Record<string, unknown>, partition: SourceRecoveryPartition, rootPath: string,
  staged: Map<string, unknown>, lookup: (id: string) => unknown,
): Record<string, unknown> {
  const payload = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
  const advertised = new Set<string>()
  const collect = (entries: unknown, key: string): void => {
    if (Array.isArray(entries)) for (const entry of entries) {
      if (isObjectRecord(entry) && typeof entry[key] === 'string') advertised.add(entry[key])
    }
  }
  collect(payload.expandable, 'handle_id')
  if (isObjectRecord(payload.pack)) {
    collect(payload.pack.expandable, 'handle_id')
    collect(payload.pack.matched_nodes, 'source_expand_handle')
  }
  if (isObjectRecord(payload.evidence) && isObjectRecord(payload.evidence.answerability)) {
    collect(payload.evidence.answerability.verification_targets, 'handle_id')
  }
  const fullyReserved = new Set(partition.catalog.owners.filter(owner => owner.retained_ranges.length === 1
    && owner.retained_ranges[0]!.start_line === owner.owner_range.start_line
    && owner.retained_ranges[0]!.end_line === owner.owner_range.end_line).map(owner => owner.node_id))
  const replacements = new Map<string, { id: string; nodeIds?: string[] } | null>()
  for (const id of advertised) {
    const handle = staged.get(id) ?? lookup(id)
    if (isSourceContinuationHandle(handle)) {
      const narrowed = restrictSourceRecoveryContinuation(handle, partition, rootPath)
      if (!narrowed) { replacements.set(id, null); continue }
      // A source cursor owns only its remaining spans. Sibling navigation is
      // advertised by the parent response and may be reissued there; copying
      // its old IDs into later source pages would create dangling references.
      // Keep every obligation and non-handle verification target unchanged.
      if (isObjectRecord(narrowed.evidence.answerability)
        && Array.isArray(narrowed.evidence.answerability.verification_targets)) {
        narrowed.evidence.answerability.verification_targets = narrowed.evidence.answerability.verification_targets
          .filter(target => !isObjectRecord(target) || typeof target.handle_id !== 'string')
      }
      const nextId = sourceContinuationHandleId(narrowed)
      staged.set(nextId, narrowed); replacements.set(id, { id: nextId })
    } else if (isStoredContextPackHandle(handle) && !handle.explicit_target && handle.follow_up.node_ids) {
      const nodeIds = handle.follow_up.node_ids.filter(nodeId => !fullyReserved.has(nodeId))
      if (!nodeIds.length) { replacements.set(id, null); continue }
      const next: StoredContextPackHandle = { ...handle, source_recovery_partition: partition,
        follow_up: { ...handle.follow_up, node_ids: nodeIds } }
      const nextId = `expand:${next.task}:${next.follow_up.evidence_class}:${createHash('sha256')
        .update(JSON.stringify(next)).digest('hex').slice(0, 12)}`
      staged.set(nextId, next); replacements.set(id, { id: nextId, nodeIds })
    }
  }
  const update = (entries: unknown): unknown => !Array.isArray(entries) ? entries : entries.flatMap(entry => {
    if (!isObjectRecord(entry) || typeof entry.handle_id !== 'string' || !replacements.has(entry.handle_id)) return [entry]
    const next = replacements.get(entry.handle_id)
    if (!next) return []
    const metadata = { ...entry }
    // Compact symbol hints lack owner IDs and cannot be narrowed by name
    // without guessing about collisions. The verified file/range hints remain.
    if (next.nodeIds && Array.isArray(entry.symbols)) delete metadata.symbols
    return [{ ...metadata, handle_id: next.id,
      ...(next.nodeIds && 'count' in entry ? { count: next.nodeIds.length } : {}),
      ...(next.nodeIds && Array.isArray(entry.preview) ? { preview: entry.preview.filter(owner =>
        !isObjectRecord(owner) || typeof owner.node_id !== 'string' || next.nodeIds!.includes(owner.node_id)) } : {}),
      ...(next.nodeIds && isObjectRecord(entry.follow_up) ? { follow_up: { ...entry.follow_up, node_ids: next.nodeIds } } : {}) }]
  })
  if (Array.isArray(payload.expandable)) payload.expandable = update(payload.expandable)
  if (isObjectRecord(payload.pack)) {
    if (Array.isArray(payload.pack.expandable)) payload.pack.expandable = update(payload.pack.expandable)
    if (Array.isArray(payload.pack.matched_nodes)) for (const node of payload.pack.matched_nodes) {
      if (!isObjectRecord(node) || typeof node.source_expand_handle !== 'string' || !replacements.has(node.source_expand_handle)) continue
      const next = replacements.get(node.source_expand_handle)
      if (next) node.source_expand_handle = next.id
      else delete node.source_expand_handle
    }
  }
  if (isObjectRecord(payload.evidence) && isObjectRecord(payload.evidence.answerability)) {
    const answer = payload.evidence.answerability
    if (Array.isArray(answer.verification_targets)) answer.verification_targets = update(answer.verification_targets)
  }
  return payload
}

function publishRecoveryHandles(payload: Record<string, unknown>, staged: Map<string, unknown>, helpers: ToolHelpers): void {
  const advertised = new Set<string>()
  const collect = (entries: unknown, key: string): void => {
    if (Array.isArray(entries)) for (const entry of entries) {
      if (isObjectRecord(entry) && typeof entry[key] === 'string') advertised.add(entry[key])
    }
  }
  collect(payload.expandable, 'handle_id')
  if (isObjectRecord(payload.pack)) {
    collect(payload.pack.expandable, 'handle_id')
    collect(payload.pack.matched_nodes, 'source_expand_handle')
  }
  if (isObjectRecord(payload.evidence) && isObjectRecord(payload.evidence.answerability)) {
    collect(payload.evidence.answerability.verification_targets, 'handle_id')
  }
  for (const [id, handle] of staged) if (advertised.has(id)) helpers.setContextPackHandle(id, handle)
}

/** Keep serialization omissions inside the same owned continuation scope. */
function finalizeGeneratedContextPackResponse(
  input: Record<string, unknown>, budget: number,
  options: NonNullable<Parameters<typeof finalizeSourceEvidenceResponse>[2]>,
  context: { prompt: string; task: ContextPackTaskKind; taskIntent: TaskContextPlan['evidence']['recipe_id']; helpers: ToolHelpers; sourceCatalog?: SourceCoherentContinuationCatalog },
): Record<string, unknown> {
  input = isolateUnverifiedSourceOwners(input, options)
  const originalPack = isObjectRecord(input.pack) ? input.pack : {}
  const originalNodes = (Array.isArray(originalPack.matched_nodes) ? originalPack.matched_nodes : []).filter(isObjectRecord)
  const recoverable = originalNodes.filter(node => typeof node.node_id === 'string' && node.node_id.length > 0
    && typeof node.source_file === 'string' && node.source_file.length > 0 && typeof node.label === 'string')
  const originalRefs = strictPayloadExpandableEntries(input)
  const classes = payloadEvidenceClasses(input)
  const contract = classifyTaskContract(context.task, { prompt: context.prompt, task_intent: context.taskIntent, budget })
  const omittedIds = new Set<string>()
  const advertisedIds = (payload: Record<string, unknown>): Set<string> => {
    const ids = new Set<string>()
    const collect = (entries: unknown, key: string): void => {
      if (Array.isArray(entries)) for (const entry of entries) if (isObjectRecord(entry) && typeof entry[key] === 'string') ids.add(entry[key])
    }
    collect(payload.expandable, 'handle_id')
    if (isObjectRecord(payload.pack)) collect(payload.pack.matched_nodes, 'source_expand_handle')
    if (isObjectRecord(payload.evidence) && isObjectRecord(payload.evidence.answerability)) collect(payload.evidence.answerability.verification_targets, 'handle_id')
    return ids
  }
  const recoveryRefs = (): { refs: ContextPackExpandableRef[]; replacements: Map<string, string> } => {
    const additions = buildExpandableRefs(contract, recoverable.filter(node => omittedIds.has(String(node.node_id))).map(node => {
      const range = isObjectRecord(node.snippet_line_range) ? node.snippet_line_range : undefined
      const evidenceClass = classes[String(node.node_id)] ?? 'primary'
      return { node_id: String(node.node_id), label: String(node.label), source_file: String(node.source_file), evidence_class: evidenceClass,
        expandable_ref: { node_id: String(node.node_id), label: String(node.label), source_file: String(node.source_file),
          ...(range && Number.isSafeInteger(range.start_line) && Number.isSafeInteger(range.end_line)
            ? { line_range: { start_line: Number(range.start_line), end_line: Number(range.end_line) } } : {}) },
        estimate_tokens: () => 0, build_entry: () => node as unknown as ContextPackNode }
    }))
    const replacements = new Map<string, string>()
    const consumed = new Set<string>()
    const merged = additions.map(addition => {
      const existing = originalRefs.filter(entry => entry.evidence_class === addition.evidence_class
        && entry.follow_up.node_ids !== undefined && !entry.symbols?.length)
      if (!existing.length) return addition
      const nodeIds = [...new Set([...addition.follow_up.node_ids!, ...existing.flatMap(entry => entry.follow_up.node_ids!)])]
      const scopes = [addition, ...existing].map(entry => entry.follow_up)
      const unrestrictedFiles = scopes.flatMap(scope => scope.focus_files.filter(file =>
        !(scope.focus_ranges ?? []).some(range => sourceFileMatchesFocus(file, [range.source_file]))))
      const ranges = scopes.flatMap(scope => scope.focus_ranges ?? []).filter(range =>
        !sourceFileMatchesFocus(range.source_file, unrestrictedFiles))
      const uniqueRanges = [...new Map(ranges.map(range => [JSON.stringify(range), range])).values()]
      const handleId = `expand:${context.task}:${addition.evidence_class}:${createHash('sha1')
        .update(JSON.stringify([addition.handle_id, ...existing.map(entry => entry.handle_id).sort()])).digest('hex').slice(0, 12)}`
      for (const entry of existing) { consumed.add(entry.handle_id); replacements.set(entry.handle_id, handleId) }
      return { ...addition, handle_id: handleId, count: nodeIds.length,
        follow_up: { ...addition.follow_up, node_ids: nodeIds,
          focus_files: [...new Set([...addition.follow_up.focus_files, ...existing.flatMap(entry => entry.follow_up.focus_files)])],
          focus_ranges: uniqueRanges } }
    })
    return { refs: [...merged, ...originalRefs.filter(entry => !consumed.has(entry.handle_id))], replacements }
  }
  const originalEvidence = isObjectRecord(input.evidence) ? input.evidence : {}
  const originalAnswer = isObjectRecord(originalEvidence.answerability) ? originalEvidence.answerability : {}
  const governance = isObjectRecord(input.governance) ? input.governance : {}
  const freshness = isObjectRecord(governance.graph_freshness) ? governance.graph_freshness : {}
  const permitted = freshness.status === 'fresh' && freshness.selected_context_status === 'fresh' && !options.verbose && options.format !== 'text' && !input.delta_session_id && input.mode !== 'delta'
    && originalAnswer.broad_search_fallback !== 'blocked' && recoverable.length > 0
  const attempt = (allDeferred = false) => {
    const { refs, replacements } = recoveryRefs()
    const staged = new Map<string, unknown>()
    const helpers = { ...context.helpers, setContextPackHandle: (id: string, value: unknown) => { staged.set(id, value) } }
    const answerability = { ...originalAnswer,
      ...(Array.isArray(originalAnswer.verification_targets) ? { verification_targets: originalAnswer.verification_targets.map(target =>
        isObjectRecord(target) && typeof target.handle_id === 'string' && replacements.has(target.handle_id)
          ? { ...target, handle_id: replacements.get(target.handle_id)! } : target) } : {}),
      ...(allDeferred ? { state: 'insufficient', answer_scope: 'partial', advisory: true,
        caveats: [...new Set([...stringValues(originalAnswer.caveats),
          'Source evidence was omitted by the output budget; expand the supplied handles.'])],
        missing_obligations: [...new Set([...stringValues(originalAnswer.missing_obligations),
          ...recoverable.map(node => `evidence:${classes[String(node.node_id)] ?? 'primary'}`)])] } : {}) }
    const candidate = { ...input, expandable: refs, evidence: { ...originalEvidence, answerability,
      ...(allDeferred ? { agent_directive: 'explore_with_caution' } : {}) },
      ...(allDeferred ? { pack: { ...originalPack, matched_nodes: [], relationships: [], _source_discovery_deferred: true } } : {}) }
    storeFinalContextPackHandles(context.prompt, context.task, context.taskIntent, refs, candidate, helpers)
    let payload = finalizeSourceEvidenceResponse(candidate, budget, { ...options,
      ...(options.flowBudget ? { flowBudget: { ...options.flowBudget,
        lookup: (id: string) => staged.get(id) ?? options.flowBudget!.lookup(id),
        store: (id: string, value: unknown) => { staged.set(id, value) } } } : {}),
      ...(options.continuations ? { continuations: { ...options.continuations,
        store: (id: string, value: SourceContinuationHandle) => { staged.set(id, value) } } } : {}) })
    const deliveredIds = (): Set<string> => {
      const pack = isObjectRecord(payload.pack) ? payload.pack : {}
      return new Set((Array.isArray(pack.matched_nodes) ? pack.matched_nodes : []).flatMap(node =>
        isObjectRecord(node) && typeof node.node_id === 'string' ? [node.node_id] : []))
    }
    if (permitted) {
      // Completion may restore an owner dropped by an earlier attempt, or one
      // from an existing omission receipt. A generic child must never replay it.
      // Source cursors for partial retained owners are a separate scope.
      const delivered = deliveredIds(), exposed = advertisedIds(payload)
      const narrowed = new Map<string, { id: string; count: number; nodeIds: string[] } | null>()
      for (const [id, handle] of [...staged]) {
        if (!exposed.has(id) || !isStoredContextPackHandle(handle) || !handle.follow_up.node_ids) continue
        const nodeIds = handle.follow_up.node_ids.filter(nodeId => !delivered.has(nodeId))
        if (nodeIds.length === handle.follow_up.node_ids.length) continue
        staged.delete(id)
        if (!nodeIds.length) { narrowed.set(id, null); continue }
        const nextId = `expand:${handle.task}:${handle.follow_up.evidence_class}:${createHash('sha1')
          .update(JSON.stringify([id, nodeIds])).digest('hex').slice(0, 12)}`
        staged.set(nextId, { ...handle, follow_up: { ...handle.follow_up, node_ids: nodeIds } })
        narrowed.set(id, { id: nextId, count: nodeIds.length, nodeIds })
      }
      if (narrowed.size) {
        const update = (entries: unknown): unknown => !Array.isArray(entries) ? entries : entries.flatMap(entry => {
          if (!isObjectRecord(entry) || typeof entry.handle_id !== 'string' || !narrowed.has(entry.handle_id)) return [entry]
          const next = narrowed.get(entry.handle_id)
          if (!next) return []
          return [{ ...entry, handle_id: next.id, ...('count' in entry ? { count: next.count } : {}),
            ...(Array.isArray(entry.preview) ? { preview: entry.preview.filter(owner =>
              !isObjectRecord(owner) || typeof owner.node_id !== 'string' || next.nodeIds.includes(owner.node_id)) } : {}),
            ...(isObjectRecord(entry.follow_up) ? { follow_up: { ...entry.follow_up, node_ids: next.nodeIds } } : {}) }]
        })
        if (Array.isArray(payload.expandable)) payload.expandable = update(payload.expandable)
        if (isObjectRecord(payload.pack) && Array.isArray(payload.pack.expandable)) payload.pack.expandable = update(payload.pack.expandable)
        if (isObjectRecord(payload.evidence) && isObjectRecord(payload.evidence.answerability)) {
          const answer = payload.evidence.answerability
          if (Array.isArray(answer.verification_targets)) answer.verification_targets = update(answer.verification_targets)
        }
        // Reprice metadata only. This does not restore source or advance direct
        // source cursors; any further budget omission enters the bounded retry.
        payload = serializeSourceEvidenceResponse(payload, budget, { verbose: true })
      }
    }
    const advertised = advertisedIds(payload)
    const accessible = new Set([...staged].flatMap(([id, handle]) => advertised.has(id) && isStoredContextPackHandle(handle)
      ? handle.follow_up.node_ids ?? [] : []))
    return { payload, staged, advertised, accessible, delivered: deliveredIds() }
  }
  const commit = (result: ReturnType<typeof attempt>): Record<string, unknown> => {
    const staged = new Map(result.staged)
    const payload = permitted && options.requestedSource && !options.verbose && options.format !== 'text'
      ? attachSourceGroupContinuation(result.payload, context.sourceCatalog, context.prompt, budget,
        (id, handle) => { staged.set(id, handle) }, options.requestedSource.rootPath,
        (original, identity) => partitionRecoveryReferences(original,
          createSourceRecoveryPartition(identity, options.requestedSource!.rootPath), options.requestedSource!.rootPath,
          staged, context.helpers.getContextPackHandle)) : result.payload
    // Allocation and recovery scopes are settled. Representation savings must
    // not fund another selection pass or change an advertised cursor.
    const compact = !options.verbose && options.format !== 'text'
      ? compactContainedSourceReferences(payload, budget) : payload
    publishRecoveryHandles(compact, staged, context.helpers)
    return compact
  }
  for (let index = 0; index < 3; index++) {
    const result = attempt()
    if (!permitted) return commit(result)
    // A source/policy refusal is terminal, not another allocation attempt.
    if (!isObjectRecord(result.payload.pack) && typeof result.payload.omitted_evidence === 'string'
      && !/output[ _]budget/.test(result.payload.omitted_evidence)) return commit(result)
    const missing = recoverable.filter(node => !result.delivered.has(String(node.node_id)) && !result.accessible.has(String(node.node_id)))
    if (!missing.length) return commit(result)
    for (const node of missing) omittedIds.add(String(node.node_id))
  }
  // A bounded navigation-only page is preferable to silently losing known
  // owners. The existing serializer still refuses honestly if even this cannot fit.
  for (const node of recoverable) omittedIds.add(String(node.node_id))
  const fallback = attempt(true)
  if (recoverable.every(node => fallback.delivered.has(String(node.node_id)) || fallback.accessible.has(String(node.node_id)))) return commit(fallback)
  // Never describe a navigation-only page as recoverable when its receipts
  // were themselves removed. No trial handle is published by this refusal.
  return serializeSourceEvidenceResponse({
    task: context.task,
    pack: { _source_discovery_deferred: true },
    evidence: { agent_directive: 'explore_with_caution', answerability: { state: 'insufficient', advisory: true,
      broad_search_fallback: originalAnswer.broad_search_fallback === 'blocked' ? 'blocked' : 'allowed',
      caveats: [...new Set([...stringValues(originalAnswer.caveats),
        'Source and omission recovery exceed the output budget; request focused source or a larger budget.'])],
      missing_obligations: [...new Set([...stringValues(originalAnswer.missing_obligations),
        ...recoverable.map(node => `evidence:${classes[String(node.node_id)] ?? 'primary'}`)])] } },
    governance: fallback.payload.governance ?? input.governance,
    omitted_evidence: 'source and omission recovery exceed output budget; request focused source or a larger budget',
  }, budget, { verbose: true })
}

/** Retry an empty owned expansion without changing its search or advancing unseen owners. */
function retryEmptyOwnedExpansion(
  baseline: Record<string, unknown>, original: Record<string, unknown>, handleId: string,
  stored: StoredContextPackHandle, budget: number, rootPath: string,
  candidates: readonly ContextPackNodeCandidate<ContextPackNode>[],
  build: (candidate: ContextPackNodeCandidate<ContextPackNode>, helpers: ToolHelpers) => Record<string, unknown>,
  helpers: ToolHelpers, options: NonNullable<Parameters<typeof finalizeSourceEvidenceResponse>[2]>,
): { payload: Record<string, unknown>; handles: Map<string, unknown> } {
  const record = (value: unknown): Record<string, unknown> => isObjectRecord(value) ? value : {}
  const clone = (value: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(value))
  const nodeIds = [...new Set(stored.follow_up.node_ids!)]
  const owned = new Set(nodeIds)
  const originalEvidence = record(original.evidence), originalAnswer = record(originalEvidence.answerability)
  const hasSource = (nodes: readonly Record<string, unknown>[]): boolean => nodes.some(node =>
    typeof node.snippet === 'string' && node.snippet.replace(/\[omitted lines \d+-\d+\]/g, '').trim().length > 0)
  let active = new Map<string, unknown>()
  const lookup = (id: string): SourceContinuationHandle | undefined => {
    const value = active.get(id) ?? helpers.getContextPackHandle(id)
    return isSourceContinuationHandle(value) ? value : undefined
  }
  // One proof cache retains source identities from unsuccessful trials too.
  const prepare = createSourceContinuationPreparation(rootPath, lookup, () => true, { verifyAllSources: true })
  const price = (payload: Record<string, unknown>): number => {
    payload.serialized_budget = { max_tokens: budget, token_count: 0, enforced: true }
    for (let index = 0; index < 12; index++) {
      const count = estimateQueryTokens(JSON.stringify(payload))
      if (record(payload.serialized_budget).token_count === count) return count
      record(payload.serialized_budget).token_count = count
    }
    throw new Error('Owned expansion token receipt did not stabilize')
  }
  const recovery = (payload: Record<string, unknown>, remaining: string[]): string | undefined => {
    const nextId = remaining.length === nodeIds.length ? handleId
      : `expand:${stored.task}:${stored.follow_up.evidence_class}:${createHash('sha256')
        .update(JSON.stringify([handleId, remaining])).digest('hex').slice(0, 12)}`
    if (remaining.length && nextId !== handleId) active.set(nextId, { ...stored,
      follow_up: { ...stored.follow_up, node_ids: remaining } })
    payload.expandable = remaining.length ? [{ kind: 'nodes', handle_id: nextId,
      evidence_class: stored.follow_up.evidence_class, count: remaining.length,
      follow_up: { ...stored.follow_up, node_ids: remaining } }] : []
    delete record(payload.pack).expandable
    const answer = record(record(payload.evidence).answerability)
    if (Array.isArray(answer.verification_targets)) answer.verification_targets = answer.verification_targets.flatMap(target =>
      isObjectRecord(target) && typeof target.handle_id === 'string'
        ? remaining.length ? [{ handle_id: nextId }] : [] : [target])
    return remaining.length ? nextId : undefined
  }
  const validate = (proof: ReturnType<ReturnType<typeof createSourceContinuationPreparation>>): boolean => {
    if (proof.refused || !proof.validate()) throw new FocusedSymbolError(
      'context_expand source or policy changed during allocation; request a fresh context_pack', false)
    return proof.valid
  }
  if (originalAnswer.broad_search_fallback !== 'blocked') for (const candidate of candidates.slice(0, 4)) {
    const entry = candidate.build_entry()
    // Metadata keeps its place in the original four-owner window and recovery
    // scope, but cannot be a source-allocation trial.
    if (typeof entry.snippet !== 'string' || entry.snippet_unverified === true || entry.snippet_source === 'derived'
      || !entry.snippet.replace(/\[omitted lines \d+-\d+\]/g, '').trim()) continue
    active = new Map()
    const trialHelpers = { ...helpers, setContextPackHandle: (id: string, value: unknown) => { active.set(id, value) } }
    const input = build(candidate, trialHelpers)
    const evidence = record(input.evidence), answer = record(evidence.answerability)
    input.evidence = { ...originalEvidence, ...evidence, answerability: { ...originalAnswer, ...answer,
      caveats: [...new Set([...stringValues(originalAnswer.caveats), ...stringValues(answer.caveats)])],
      missing_obligations: [...new Set([...stringValues(originalAnswer.missing_obligations), ...stringValues(answer.missing_obligations)])],
    } }
    recovery(input, nodeIds)
    const freshness = record(record(input.governance).graph_freshness)
    if (freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh') throw new FocusedSymbolError(
      'context_expand source freshness could not be verified during allocation; request a fresh context_pack', false)
    if (!validate(prepare(input))) continue
    let payload: Record<string, unknown>
    try {
      payload = finalizeSourceEvidenceResponse(input, budget, { ...options,
        continuations: { rootPath, store: (id, value) => { active.set(id, value) } } })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Budget ')) continue
      throw error
    }
    if (stored.source_recovery_partition) {
      payload = partitionRecoveryReferences(payload, stored.source_recovery_partition, rootPath, active, helpers.getContextPackHandle)
      const filtered = filterSourceRecoveryResponse(payload, stored.source_recovery_partition, budget,
        { expectedRoot: rootPath, lookupSourceHandle: lookup })
      filtered.validate(); payload = filtered.payload
    }
    const nodes = Array.isArray(record(payload.pack).matched_nodes)
      ? (record(payload.pack).matched_nodes as unknown[]).filter(isObjectRecord) : []
    if (!nodes.length) continue
    const proof = prepare(payload)
    if (!validate(proof) || nodes.some(node => typeof node.node_id !== 'string' || !owned.has(node.node_id))) continue
    if (!hasSource(nodes)) continue
    const recovered = new Set(nodes.flatMap(node => {
      const partial = node.snippet_truncated === true || Array.isArray(node.snippet_omitted_ranges) && node.snippet_omitted_ranges.length > 0
      // A partial body is not consumed unless its exact remaining source has a
      // usable cursor advertised by this response, authenticated above.
      const cursor = typeof node.source_expand_handle === 'string' && proof.handles.has(node.source_expand_handle)
      return !partial || cursor ? [String(node.node_id)] : []
    }))
    const remaining = nodeIds.filter(id => !recovered.has(id)), nextId = recovery(payload, remaining)
    // Recovery is priced before committing. Do not let another source-removal
    // pass turn the selected trial back into an apparent progress page.
    let compact: Record<string, unknown>
    try { compact = serializeSourceEvidenceResponse(payload, budget, { verbose: true }) }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Budget ')) continue
      throw error
    }
    const compactNodes = Array.isArray(record(compact.pack).matched_nodes)
      ? (record(compact.pack).matched_nodes as unknown[]).filter(isObjectRecord) : []
    if (compactNodes.length !== nodes.length || !hasSource(compactNodes) || price(compact) > budget || !validate(proof)) continue
    const finalProof = prepare(compact)
    if (!validate(finalProof)) continue
    const finalRecovered = new Set(compactNodes.flatMap(node => {
      const partial = node.snippet_truncated === true || Array.isArray(node.snippet_omitted_ranges) && node.snippet_omitted_ranges.length > 0
      return !partial || typeof node.source_expand_handle === 'string' && finalProof.handles.has(node.source_expand_handle)
        ? [String(node.node_id)] : []
    }))
    if ([...recovered].some(id => !finalRecovered.has(id))) continue
    const recoveryHandle = nextId ? active.get(nextId) ?? helpers.getContextPackHandle(nextId) : undefined
    if (nextId && (!Array.isArray(compact.expandable) || !compact.expandable.some(entry => record(entry).handle_id === nextId)
      || !isStoredContextPackHandle(recoveryHandle)
      || JSON.stringify(recoveryHandle.follow_up.node_ids) !== JSON.stringify(remaining))) continue
    if (stored.source_recovery_partition) verifySourceRecoveryPartition(stored.source_recovery_partition, rootPath)
    return { payload: compact, handles: active }
  }
  validate(prepare({ pack: { matched_nodes: [] } }))
  const payload = clone(baseline)
  const blocked = originalAnswer.broad_search_fallback === 'blocked'
  const status = blocked ? 'blocked' : 'budget_insufficient'
  payload.handle_id = handleId
  payload.expansion_status = status
  payload.delivered_source_nodes = 0
  payload.pack = { ...record(payload.pack), matched_nodes: [], relationships: [] }
  payload.evidence = { ...originalEvidence, answerability: { ...originalAnswer,
    state: 'insufficient', answer_scope: 'partial', advisory: true,
    caveats: [...new Set([...stringValues(originalAnswer.caveats), blocked
      ? 'Source expansion remains blocked by the original evidence policy.'
      : 'No source delivered within the bounded allocation attempts; retry the original handle with a larger budget.'])] } }
  active = new Map(); recovery(payload, nodeIds)
  // Keep the original immutable handle even when detailed evidence cannot fit.
  try {
    const compact = serializeSourceEvidenceResponse(payload, budget, { verbose: true })
    compact.handle_id = handleId; compact.expansion_status = status; compact.delivered_source_nodes = 0
    compact.expandable = [{ handle_id: handleId }]
    if (price(compact) <= budget) return { payload: compact, handles: new Map() }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Budget ')) throw error
  }
  const freshness = record(record(original.governance).graph_freshness)
  const minimal = { handle_id: handleId, expansion_status: status, expandable: [{ handle_id: handleId }],
    evidence: { answerability: { state: 'insufficient', broad_search_fallback: blocked ? 'blocked' : 'allowed' } },
    limitations: { graph: freshness.status, source: freshness.selected_context_status, obligations: 'not resolved; retry original scope' } }
  if (price(minimal) > budget) throw new Error('Budget cannot carry the original expansion retry scope and evidence status')
  return { payload: minimal, handles: new Map() }
}

/** Defer only known secondary owners with a current, recoverable source scope. */
function discoverySourceDeferral(
  graph: KnowledgeGraph, graphPath: string, retrieval: RetrieveResult, nodes: readonly ContextPackNode[],
): { ids: Set<string>; expandable: ContextPackExpandableRef[] } | undefined {
  const root = resolveGraphSourceRoot(graphPath, graph)
  const scopedCore = retrieval[sourceDiscoveryCoreKey] ? undefined : scopedSourceDeferralCore(retrieval, nodes, root)
  const provenance = retrieval[sourceDiscoveryCoreKey] ?? scopedCore
  if (!provenance || provenance.question !== repositoryEvidenceQuestion(retrieval, root) || !retrieval.task_contract) return undefined
  const protectedIds = retrieval[sourceDiscoveryCoreKey]
    ? protectSourceDiscoveryWitnesses(retrieval, nodes, new Set(provenance.node_ids), root)
    : new Set(provenance.node_ids)
  const knownIds = new Set(provenance.selected_node_ids)
  // A retained excerpt reference must keep its actual text supplier.
  for (const node of nodes) if (node.snippet_ref) protectedIds.add(node.snippet_ref)
  if (!nodes.some(node => node.node_id && protectedIds.has(node.node_id))) return undefined
  const cache = new Map<string, string[] | null>()
  const candidates: ContextPackNodeCandidate[] = []
  let probes = 0
  for (const node of nodes) {
    if (!node.node_id || !knownIds.has(node.node_id) || protectedIds.has(node.node_id)
      || node.snippet_source === 'derived' || node.snippet_unverified || probes++ >= 32) continue
    const attributes = graph.nodeAttributes(node.node_id), sourceFile = String(attributes.source_file ?? '')
    if (resolve(root, sourceFile) !== resolve(root, node.source_file)) continue
    const lines = readEvidenceLines(sourceFile, root, cache)
    const indexed = lineRangeFromSourceLocation(attributes.source_location)
    if (!lines || !indexed) continue
    const file = String(attributes.label ?? '') === basename(sourceFile)
    if (!file && sourceDeclarationKind(lines, indexed, node.label, sourceFile) === undefined) continue
    const range = file ? { start: 1, end: lines.length } : resolveSourceSymbolRange(lines, indexed, node.label, sourceFile)
    if (!range || range.start < 1 || range.end > lines.length) continue
    const evidenceClass = node.evidence_class ?? (node.relevance_band === 'direct' ? 'primary'
      : node.relevance_band === 'related' ? 'supporting' : 'structural')
    candidates.push({ node_id: node.node_id, label: node.label, source_file: node.source_file,
      line_number: range.start, evidence_class: evidenceClass,
      expandable_ref: { node_id: node.node_id, label: node.label, source_file: node.source_file,
        line_range: { start_line: range.start, end_line: range.end } },
      estimate_tokens: () => 0, build_entry: () => node })
  }
  if (!candidates.length) return undefined
  if (scopedCore) {
    // Focused expansion examines every matching graph owner overlapping the
    // handle's full scope, including nested or unsupported callable forms.
    // Keep the original packet if a simple advertised name could collide there.
    const advertised = new Map(candidates.map(candidate => [candidate.label.replace(/\(\)$/, ''), candidate.node_id]))
    for (const [nodeId, attributes] of graph.nodeEntries()) {
      const name = String(attributes.label ?? '').replace(/\(\)$/, '').split(/[.:]/).at(-1)!
      if (!advertised.has(name) || advertised.get(name) === nodeId || attributes.external_call === true) continue
      const indexed = lineRangeFromSourceLocation(attributes.source_location)
      if (!indexed) continue
      const file = resolve(root, String(attributes.source_file ?? ''))
      if (!candidates.some(candidate => {
        const owner = candidate.expandable_ref!, range = owner.line_range!
        return resolve(root, owner.source_file) === file && indexed.start <= range.end_line && indexed.end >= range.start_line
      })) continue
      const lines = readEvidenceLines(String(attributes.source_file ?? ''), root, cache)
      if (!lines) return undefined
      const label = String(attributes.label ?? ''), kind = sourceDeclarationKind(lines, indexed, label, file)
      // Match focusedSymbolOwner's refusal surface. Non-callable containers can
      // share the name of a nested implementation without being selectable.
      if (kind === 'function' || (kind === undefined
        && (/\(\)$/.test(label) || /^(?:function|method)$/.test(String(attributes.node_kind ?? ''))))) return undefined
    }
  }
  const expandable = buildExpandableRefs(retrieval.task_contract, candidates)
  if (!expandable.length || !expandable.every(isContextPackExpandableRef)) return undefined
  // Keep every private owner identity; the wire codec emits only compact scope hints.
  for (const entry of expandable) entry.preview = candidates.filter(candidate => candidate.evidence_class === entry.evidence_class)
    .map(candidate => candidate.expandable_ref!)
  if (scopedCore) for (const entry of expandable) entry.symbols = entry.preview.map(owner => owner.label.replace(/\(\)$/, ''))
  return { ids: new Set(candidates.map(node => node.node_id!)), expandable }
}

class FocusedSymbolError extends Error {
  constructor(message: string, readonly invalidParams: boolean) { super(message) }
}

interface FocusedSymbolOwner {
  nodeId: string
  sourceFile: string
  range: { start: number; end: number }
  snippet: string
  validate(): void
}

/** Resolve only a current source declaration inside the session-owned scope. */
function focusedSymbolOwner(
  graph: KnowledgeGraph, graphPath: string, stored: StoredContextPackHandle, symbol: string,
  allowNamedAssignment = false,
  onlyNodeId?: string,
): FocusedSymbolOwner {
  const root = resolveGraphSourceRoot(graphPath, graph), realRoot = realpathSync(root)
  const name = symbol.replace(/\(\)$/, ''), leaf = name.split('.').at(-1)
  const policy = () => {
    const path = resolve(root, '.madarignore')
    try { lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { patterns: [] as string[], fingerprint: 'missing' }
      throw error
    }
    const canonical = realpathSync(path), local = relative(realRoot, canonical), stat = statSync(canonical)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || !stat.isFile() || stat.size > 64 * 1024) throw new Error('Unverifiable expansion source policy')
    const text = readFileSync(canonical, 'utf8'), patterns = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    if (Buffer.byteLength(text) > 64 * 1024 || patterns.length > 1024 || realpathSync(path) !== canonical) throw new Error('Unverifiable expansion source policy')
    return { patterns, fingerprint: createHash('sha256').update(`${canonical}\0${text}`).digest('hex') }
  }
  const initialPolicy = policy(), exclusions = extractPromptExclusions(stored.prompt)
  const excluded = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, root)
  if (!excluded.valid) throw new FocusedSymbolError('context_expand symbol cannot verify the stored exclusion scope', true)
  if (allowNamedAssignment && excluded.matchesLabel(name)) throw new FocusedSymbolError('Explicit target symbol is excluded by the request scope', true)
  const verifiedFreshFiles = new Set<string>()
  const cache = new Map<string, string[] | null>(), parsed = new Map<string, ts.SourceFile>()
  const assignmentAliases = new Map<string, Array<{ qualifiedName: string; start: number; end: number }>>()
  const owners = new Map<string, FocusedSymbolOwner>()
  let bytes = 0
  if (onlyNodeId !== undefined && (!graph.hasNode(onlyNodeId) || !stored.follow_up.node_ids?.includes(onlyNodeId))) {
    throw new FocusedSymbolError('Callee source owner is no longer indexed; request a fresh context_pack', false)
  }
  const sourceEntries = onlyNodeId === undefined ? graph.nodeEntries() : [[onlyNodeId, graph.nodeAttributes(onlyNodeId)] as const]
  for (const [nodeId, attributes] of sourceEntries) {
    const sourceFile = String(attributes.source_file ?? ''), label = String(attributes.label ?? '')
    const logical = resolve(root, sourceFile)
    const directName = label.replace(/\(\)$/, '').split(/[.:]/).at(-1) === leaf
    if (!stored.follow_up.focus_files.some(file => resolve(root, file) === logical) || attributes.external_call === true
      || (!directName && (!allowNamedAssignment || name.includes('.') || !label.includes('.')))
      || /\.d\.[cm]?tsx?$/i.test(sourceFile)) continue
    const inspected = inspectSourceEvidencePath(sourceFile, root)
    if (inspected.status === 'unavailable') continue
    const canonical = inspected.path
    if (isDiscoveryPathIgnored(logical, root, initialPolicy.patterns)
      || isDiscoveryPathIgnored(canonical, realRoot, initialPolicy.patterns)
      || exclusions.excludedDomains.includes(classifySourceDomain(logical, root) as never)
      || exclusions.excludedDomains.includes(classifySourceDomain(canonical, realRoot) as never)
      || excluded.matchesSource(logical, label) || excluded.matchesPath(canonical, realRoot)) continue
    const indexed = lineRangeFromSourceLocation(attributes.source_location)
    if (!indexed) continue
    const focusRanges = (stored.follow_up.focus_ranges ?? []).filter(part => resolve(root, part.source_file) === logical)
    if (focusRanges.length && !focusRanges.some(part => rangeOverlaps(indexed, part))) continue
    if (inspected.status === 'bounded') {
      const current = inspectSourceEvidencePath(sourceFile, root)
      if (realpathSync(root) !== realRoot || policy().fingerprint !== initialPolicy.fingerprint
        || current.status !== 'bounded' || current.path !== canonical) {
        throw new FocusedSymbolError('context_expand symbol source or policy changed during verification; request a fresh context_pack', false)
      }
      throw new FocusedSymbolError(`context_expand symbol verification unavailable: ${inspected.reason} (max_bytes=${inspected.maxBytes}). Read the requested source file directly with a native source reader or editor that honors the same workspace and exclusion scope.`, false)
    }
    if (!verifiedFreshFiles.has(logical)) {
      requireFreshSelectedContext(analyzeGraphContextFreshness(graphPath, graph, { selected_source_files: [sourceFile] }), 'context_expand symbol')
      verifiedFreshFiles.add(logical)
    }
    if (!cache.has(canonical) && cache.size >= 32) throw new FocusedSymbolError('context_expand symbol source verification exceeded its bound', false)
    const cached = cache.has(canonical), lines = readEvidenceLines(sourceFile, root, cache)
    if (!lines) throw new FocusedSymbolError('context_expand symbol has an unreadable matching source owner within this handle scope', false)
    if (!cached) bytes += Buffer.byteLength(lines.join('\n'))
    if (bytes > 1024 * 1024) throw new FocusedSymbolError('context_expand symbol source verification exceeded its bound', false)
    // A named function expression on a static assignment has two source names:
    // its assignment path and its internal declaration name. Match both against
    // the current AST, while keeping the same exact indexed owner and range.
    let namedAssignment: { qualifiedName: string; start: number; end: number } | undefined
    if (!directName) {
      if (!parsed.has(canonical)) parsed.set(canonical, ts.createSourceFile(canonical, lines.join('\n'), ts.ScriptTarget.Latest, true))
      if (!assignmentAliases.has(canonical)) {
        const syntax = parsed.get(canonical)!, aliases: Array<{ qualifiedName: string; start: number; end: number }> = []
        const visitAlias = (node: ts.Node): void => {
          const occurrence = sourceFunctionOccurrence(node, syntax)
          if (occurrence && ts.isBinaryExpression(node)) {
            let value = node.right
            while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isNonNullExpression(value)) value = value.expression
            if (ts.isFunctionExpression(value) && value.name?.text === name) aliases.push(occurrence)
          }
          ts.forEachChild(node, visitAlias)
        }
        visitAlias(syntax)
        assignmentAliases.set(canonical, aliases)
      }
      namedAssignment = assignmentAliases.get(canonical)!.find(occurrence => occurrence.qualifiedName === label.replace(/\(\)$/, '')
        && occurrence.start === indexed.start && occurrence.end === indexed.end)
      if (!namedAssignment) continue
    }
    const kind = sourceDeclarationKind(lines, indexed, label, canonical)
    if (kind !== 'function') {
      if (kind === undefined && (/\(\)$/.test(label) || /^(?:function|method)$/.test(String(attributes.node_kind ?? '')))) {
        throw new FocusedSymbolError('context_expand symbol has an unverifiable matching source owner within this handle scope', true)
      }
      continue
    }
    const range = resolveSourceSymbolRange(lines, indexed, label, canonical)
    if (!range || range.end > lines.length) throw new FocusedSymbolError('context_expand symbol has an unverifiable matching source owner within this handle scope', true)
    if (focusRanges.length && !focusRanges.some(part => part.start_line <= range.start && range.end <= part.end_line)) continue
    const qualified = sourceDeclarationQualifiedName(lines, range, label, canonical)
    if (!qualified) throw new FocusedSymbolError('context_expand symbol has an unverifiable matching source owner within this handle scope', true)
    if (namedAssignment ? (qualified !== namedAssignment.qualifiedName || range.start !== namedAssignment.start || range.end !== namedAssignment.end)
      : (name.includes('.') ? qualified !== name : qualified.split('.').at(-1) !== name)) continue
    if (!parsed.has(canonical)) parsed.set(canonical, ts.createSourceFile(canonical, lines.join('\n'), ts.ScriptTarget.Latest, true))
    const syntax = parsed.get(canonical)!
    if ((syntax as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) {
      throw new FocusedSymbolError('context_expand symbol has an unverifiable matching source owner within this handle scope', true)
    }
    let concrete = 0
    const visit = (node: ts.Node): void => {
      const occurrence = sourceFunctionOccurrence(node, syntax)
      if (occurrence && occurrence.start === range.start && occurrence.end === range.end
        && occurrence.qualifiedName === qualified) concrete++
      const body = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) ? node.body
        : ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          ? node.initializer.body : undefined
      if (body && syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1 === range.start
        && syntax.getLineAndCharacterOfPosition(node.getEnd()).line + 1 === range.end) concrete++
      ts.forEachChild(node, visit)
    }
    visit(syntax)
    if (concrete !== 1) throw new FocusedSymbolError('context_expand symbol has no unique concrete implementation within this handle scope', true)
    const text = lines.join('\n'), identity = JSON.stringify([canonical, range.start, range.end, qualified])
    if (!owners.has(identity)) owners.set(identity, { nodeId, sourceFile, range,
      snippet: lines.slice(range.start - 1, range.end).join('\n'),
      validate: () => {
        requireFreshSelectedContext(analyzeGraphContextFreshness(graphPath, graph, { selected_source_files: [sourceFile] }), 'context_expand symbol')
        if (realpathSync(root) !== realRoot || policy().fingerprint !== initialPolicy.fingerprint
          || sourcePathForEvidence(sourceFile, root) !== canonical || readEvidenceLines(sourceFile, root)?.join('\n') !== text) {
          throw new FocusedSymbolError('context_expand symbol source changed during verification; request a fresh context_pack', false)
        }
      },
    })
  }
  if (owners.size !== 1) throw new FocusedSymbolError(owners.size
    ? `context_expand symbol '${symbol}' is ambiguous within this handle scope; use an exact qualified name`
    : `context_expand symbol '${symbol}' has no verified function owner within this handle scope`, true)
  const owner = owners.values().next().value!
  owner.validate()
  return owner
}

/** Names only: suggest current exact owners after a failed explicit lookup.
 * Token overlap discovers candidates; the ordinary scoped resolver verifies
 * each suggestion. This never substitutes an owner or publishes navigation.
 */
function explicitTargetSuggestions(
  graph: KnowledgeGraph, graphPath: string, stored: StoredContextPackHandle, symbol: string,
): string[] {
  const words = [...new Set(tokenizeLabel(symbol))]
  if (words.length < 2 || words.length > 16 || graph.numberOfNodes() > 50_000) return []
  const root = resolveGraphSourceRoot(graphPath, graph)
  const files = new Set(stored.follow_up.focus_files.map(file => resolve(root, file)))
  const candidates = new Set<string>()
  for (const [, node] of graph.nodeEntries()) {
    if (!files.has(resolve(root, String(node.source_file ?? ''))) || node.external_call === true) continue
    const name = String(node.label ?? '').replace(/\(\)$/, '')
    if (!name || name === symbol || name.length > 160 || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)) continue
    const tokens = new Set(tokenizeLabel(name))
    if (words.every(word => tokens.has(word))) candidates.add(name)
    if (candidates.size > 8) return []
  }
  const suggestions: string[] = [], validators: Array<() => void> = []
  for (const name of [...candidates].sort((left, right) => left.length - right.length || left.localeCompare(right)).slice(0, 4)) {
    try {
      const owner = focusedSymbolOwner(graph, graphPath, stored, name)
      owner.validate()
      suggestions.push(name)
      validators.push(owner.validate)
      if (suggestions.length === 3) break
    } catch { /* Unsupported, excluded, stale or ambiguous names are not hints. */ }
  }
  try { for (const validate of validators) validate() } catch { return [] }
  return suggestions
}

function prepareFocusedExpansionPayload(
  graph: KnowledgeGraph,
  graphPath: string,
  handleId: string,
  stored: StoredContextPackHandle,
  budget: number,
  helpers: ToolHelpers,
  selectedSymbol?: FocusedSymbolOwner,
): {
  candidates: readonly ContextPackNodeCandidate<ContextPackNode>[]
  build: (nodes: readonly ContextPackNodeCandidate<ContextPackNode>[], outputHelpers: ToolHelpers) => Record<string, unknown>
} {
  const plannerBudget = Math.max(budget, 3)
  const communities = communitiesFromGraph(graph)
  const communityLabels = {
    ...buildCommunityLabels(graph, communities),
    ...helpers.readStoredCommunityLabels(graphPath),
  }
  const focusFiles = stored.follow_up.focus_files
  const focusRanges = stored.follow_up.focus_ranges ?? []
  const nodeCandidates: Array<ContextPackNodeCandidate<ContextPackNode>> = []
  const communityIds = new Set<number>()
  const includedIds = new Set<string>()
  const snippetFileCache = new Map<string, string[] | null>()
  const projectRoot = resolveGraphSourceRoot(graphPath, graph)

  // An omission handle continues the ranked owners that did not fit. File
  // ranges constrain those identities; they do not authorize re-enumerating
  // every declaration inside an omitted file container.
  const sourceEntries = !selectedSymbol && stored.follow_up.node_ids !== undefined
    ? stored.follow_up.node_ids.map(nodeId => {
      if (!graph.hasNode(nodeId)) throw new FocusedSymbolError('context_expand omitted source owner is no longer indexed; request a fresh context_pack', false)
      return [nodeId, graph.nodeAttributes(nodeId)] as const
    }) : graph.nodeEntries()
  for (const [nodeId, attributes] of sourceEntries) {
    if (selectedSymbol && nodeId !== selectedSymbol.nodeId) continue
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
    const evidenceClass = stored.evidence_classes && Object.hasOwn(stored.evidence_classes, nodeId)
      ? stored.evidence_classes[nodeId]! : stored.follow_up.evidence_class

    nodeCandidates.push({
      label: String(attributes.label ?? nodeId),
      node_id: nodeId,
      source_file: sourceFile,
      line_number: lineNumber,
      evidence_class: evidenceClass,
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

        const fullSymbol = selectedSymbol && estimateContextPackEntryTokens(String(attributes.label ?? nodeId), sourceFile, lineNumber, selectedSymbol.snippet) <= budget
          ? { snippet: selectedSymbol.snippet, lineNumber: selectedSymbol.range.start, scope: 'symbol' as const,
              snippet_line_range: { start_line: selectedSymbol.range.start, end_line: selectedSymbol.range.end },
              snippet_omitted_ranges: [] as Array<{ start_line: number; end_line: number }>, snippet_truncated: false } : undefined
        const excerpt = fullSymbol ?? snippetSourcePathCandidates(graphPath, sourceFile, projectRoot)
          .map(path => readQueryEvidenceSnippet(path, lineNumber, {
            question: stored.prompt, label: String(attributes.label ?? nodeId),
            sourceLocation: typeof attributes.source_location === 'string' ? attributes.source_location : null,
            fileNodeLike: String(attributes.node_kind ?? '') === 'file'
              || String(attributes.label ?? '').trim().toLowerCase() === basename(sourceFile).trim().toLowerCase(),
            derived: derived || sourceRange === null, fileCache: snippetFileCache,
            ...(projectRoot ? { rootPath: projectRoot } : {}),
          })).find(value => value !== null)
        const snippet = excerpt?.snippet ?? null
        builtEntry = {
          ...(excerpt ? { snippet_line_number: excerpt.lineNumber, snippet_scope: excerpt.scope,
            snippet_line_range: excerpt.snippet_line_range, snippet_omitted_ranges: excerpt.snippet_omitted_ranges,
            snippet_truncated: excerpt.snippet_truncated } : {}),
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
          relevance_band: relevanceBandForEvidenceClass(evidenceClass),
          evidence_class: evidenceClass,
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
  const sourceDependencies = selectSourceDependencies(graph, [...includedIds], projectRoot, snippetFileCache, {
    includeCallers: false,
    inspectionOnly: true,
    allowedSourceFiles: new Set([...includedIds].map(id => resolve(projectRoot ?? '.', String(graph.nodeAttributes(id).source_file ?? '')))),
  })
  const relationships = [
    ...reconcileSourceCalls(collectRelationships(graph, includedIds), sourceDependencies),
    ...sourceDependencies.relationships.map(edge => ({ ...edge,
      from: String(graph.nodeAttributes(edge.from_id).label ?? ''),
      to: String(graph.nodeAttributes(edge.to_id).label ?? ''),
    })),
  ].filter((edge, index, edges) => edges.findIndex(other => other.from_id === edge.from_id && other.to_id === edge.to_id && other.relation === edge.relation) === index)
  const build = (nodes: readonly ContextPackNodeCandidate<ContextPackNode>[], outputHelpers: ToolHelpers): Record<string, unknown> => {
    const pack = compileContextPack({
      task_contract: classifyTaskContract(stored.task, {
        budget,
        prompt: stored.prompt,
        task_intent: stored.task_intent,
      }),
      nodes,
      relationships,
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
      source_dependencies: { ...sourceDependencies.receipt,
        ...(stored.lexical_definition_context ? { lexical_definition_context: stored.lexical_definition_context } : {}) },
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
        ...(node.snippet_line_number !== undefined ? { snippet_line_number: node.snippet_line_number } : {}),
        ...(node.snippet_scope ? { snippet_scope: node.snippet_scope } : {}),
        ...(node.snippet_line_range ? { snippet_line_range: node.snippet_line_range } : {}),
        ...(node.snippet_omitted_ranges ? { snippet_omitted_ranges: node.snippet_omitted_ranges } : {}),
        ...(node.snippet_truncated !== undefined ? { snippet_truncated: node.snippet_truncated } : {}),
        ...(node.snippet_unverified !== undefined ? { snippet_unverified: node.snippet_unverified } : {}),
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
    storeExpandableHandles(stored.prompt, stored.task, stored.task_intent, metadata.expandable, outputHelpers,
      { ...stored.evidence_classes, ...payloadEvidenceClasses({ pack: retrieval }) }, stored.lexical_definition_context)

    const compactRetrieval = compactRetrieveResult(retrieval, { snippetBudget: budget, topNWithSnippet: retrieval.matched_nodes.length })
    const payload = {
      ...contextPackBasePayload(stored.task, stored.prompt, budget, graphPath, plan),
      handle_id: handleId,
      pack: compactRetrieval,
      matched_focus: nodes.length,
      ...metadata,
      evidence: evidenceForRetrievePayload({
        ...retrieval,
        matched_nodes: compactRetrieval.matched_nodes,
        relationships: compactRetrieval.relationships,
      }, graphPath),
    }
    applySourceLexicalCaution(payload)
    return payload
  }
  return { candidates: nodeCandidates, build }
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
    case 'graph_summary': {
      const summary = buildGraphSummary(graph)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...summary,
        evidence: evidenceForGraphSummaryPayload(summary, graphPath),
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
      const nodeId = helpers.stringParam(toolArguments, 'node_id')
      if ((Object.hasOwn(toolArguments, 'node_id') && !nodeId?.trim()) ||
          (Object.hasOwn(toolArguments, 'label') && !label?.trim()) ||
          (!nodeId && !label)) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `impact requires a nonempty string node_id or label parameter <= ${helpers.maxStdioTextLength} characters`)
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
      let impactResult: ImpactResult
      try {
        impactResult = analyzeImpact(graph, communityLabels, {
          ...(label ? { label } : {}),
          ...(nodeId ? { nodeId } : {}),
          ...(impactDepth !== null ? { depth: impactDepth } : {}),
          ...(edgeTypes && edgeTypes.length > 0 ? { edgeTypes } : {}),
        })
      } catch (error) {
        if (!(error instanceof ImpactTargetResolutionError)) throw error
        return helpers.ok(id, {
          ...helpers.textToolResult(JSON.stringify({
            status: error.status,
            selector: error.selector,
            message: error.message,
            candidates: error.candidates,
            total_candidates: error.total_candidates,
          })),
          isError: true,
        })
      }
      const useVerboseImpact = toolArguments.verbose === true || toolArguments.compact === false
      const impactPayload = useVerboseImpact
        ? impactResult
        : {
            ...compactImpactResult(impactResult),
            missing_context: impactResult.traversal && impactResult.traversal.status !== 'complete'
              ? [`impact:${impactResult.traversal.status}`]
              : [],
          }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(
        {
          ...impactPayload,
          evidence: evidenceForImpactPayload(impactResult, graphPath, label ?? nodeId ?? undefined),
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
            impactTraversalSummary: prResult.impact_traversal,
            graphPath,
            coveredWorkflowOwners: collectWorkflowOwners(prResult.changed_files),
          }),
        })))
      }
      const compactPrImpact = compactPrImpactResult(prResult)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...compactPrImpact,
        missing_context: [
          ...(prResult.review_bundle.coverage ?? emptyCoverage()).missing_required,
          ...((prResult.impact_traversal?.depth_limited_targets ?? 0) > 0 ? ['impact:depth_limited'] : []),
          ...((prResult.impact_traversal?.node_limited_targets ?? 0) > 0 ? ['impact:node_limited'] : []),
        ],
        evidence: buildMadarResponseEvidence({
          coverage: prResult.review_bundle.coverage,
          impactTraversalSummary: prResult.impact_traversal,
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
          storeExpandableHandles(question, retrievePlan.task_kind, retrievePlan.task_intent, result.expandable, helpers,
            undefined, result.source_dependencies?.lexical_definition_context)
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
          evidence: evidenceForRetrievePayload(payload, graphPath),
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
      const prompt = toolArguments.prompt
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_CONTEXT_PACK_PROMPT_LENGTH) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_pack requires a non-empty string prompt parameter <= ${MAX_CONTEXT_PACK_PROMPT_LENGTH} characters`)
      }

      const rawTask = helpers.stringParam(toolArguments, 'task')
      if (rawTask !== null && !isContextPackTaskKind(rawTask)) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'task must be one of explain, implement, review, impact')
      }
      const resolvedTask = resolveTaskSelection(prompt, rawTask ?? 'explain', { explicit: rawTask !== null })
      const task = resolvedTask.task_kind
      const changesReview = task === 'review' && reviewTargetsChanges(prompt, toolArguments)
      const budget = helpers.numberParamAlias(toolArguments, ['budget'], { min: MIN_SOURCE_EVIDENCE_BUDGET, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && budget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between ${MIN_SOURCE_EVIDENCE_BUDGET} and ${helpers.maxStdioTokenBudget}`)
      }
      const resolvedBudget = budget ?? 3000
      if (Object.hasOwn(toolArguments, 'targets')) {
        const unsupported = Object.keys(toolArguments).filter(key => !['prompt', 'task', 'budget', 'targets'].includes(key))
        if (unsupported.length || (Object.hasOwn(toolArguments, 'task') && toolArguments.task !== 'explain')) {
          return helpers.failure(id, helpers.jsonrpcInvalidParams,
            'context_pack targets accepts only prompt, targets, optional task=explain and budget')
        }
        try {
          const targets = parseExplicitSourceTargets(toolArguments.targets)
          const owners = targets.map(target => {
            const stored: StoredContextPackHandle = { prompt, task: 'explain', task_intent: 'explain',
              follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary', focus_files: [target.file], focus_ranges: [] } }
            try {
              const owner = focusedSymbolOwner(graph, graphPath, stored, target.symbol, true)
              return { ...owner, label: String(graph.nodeAttributes(owner.nodeId).label ?? target.symbol) }
            } catch (error) {
              if (error instanceof FocusedSymbolError) {
                const missingOwner = error.invalidParams && error.message.includes('has no verified function owner')
                const suggestions = missingOwner
                  ? explicitTargetSuggestions(graph, graphPath, stored, target.symbol) : []
                const message = missingOwner
                  ? 'no verified function owner within the requested file and exclusion scope. Explicit targets support verified JS/TS functions only'
                  : error.message
                const hint = suggestions.length ? `. Verified symbols in this file: ${suggestions.join(', ')}. Retry with an exact symbol.`
                  : missingOwner ? '. For other source, use native source tools only within the same workspace and exclusion scope.' : ''
                throw new FocusedSymbolError(`Target '${target.file}:${target.symbol}': ${message}${hint}`, error.invalidParams)
              }
              throw error
            }
          })
          const rootPath = resolveGraphSourceRoot(graphPath, graph)
          const selected = resolveExplicitSourceCallees({ graph, rootPath, prompt, targets, callers: owners,
            verifyTarget: target => {
              const stored: StoredContextPackHandle = { prompt, task: 'explain', task_intent: 'explain',
                follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary',
                  focus_files: [target.source_file], focus_ranges: [{ source_file: target.source_file, ...target.range }],
                  node_ids: [target.node_id] } }
              const symbol = target.label.startsWith('.') ? target.label.slice(1) : target.label
              const owner = focusedSymbolOwner(graph, graphPath, stored, symbol, false, target.node_id)
              const lines = readEvidenceLines(owner.sourceFile, rootPath)
              const qualified = lines && sourceDeclarationQualifiedName(lines, owner.range, target.label, owner.sourceFile)
              if (!qualified) throw new ExplicitSourceTargetError('Callee source has no verified qualified name')
              return { ...owner, label: `${qualified}()` }
            },
          })
          const unique = [...new Map(selected.map(owner => [owner.nodeId, owner])).values()]
          const governance = { graph_freshness: analyzeGraphContextFreshness(graphPath, graph,
            { selected_source_files: unique.map(owner => owner.sourceFile) }) }
          const result = buildExplicitSourceTargetPayload({ owners: unique, prompt, task: 'explain',
            taskIntent: 'explain', budget: resolvedBudget, rootPath, governance, finalize: finalizeSourceEvidenceResponse })
          for (const owner of selected) owner.validate()
          for (const [handleId, handle] of result.handles) helpers.setContextPackHandle(handleId, handle)
          return helpers.ok(id, helpers.textToolResult(JSON.stringify(result.payload)))
        } catch (error) {
          return helpers.failure(id, error instanceof ExplicitSourceTargetError
            || (error instanceof FocusedSymbolError && error.invalidParams) ? helpers.jsonrpcInvalidParams : helpers.jsonrpcServerError,
          error instanceof Error ? error.message : 'Explicit source targets could not verify current source')
        }
      }
      const plannerBudget = Math.max(resolvedBudget, 3)
      const initialPlan = buildTaskContextPlan({
        task_kind: task,
        prompt,
        budget: plannerBudget,
        task_intent: task === 'review' && !changesReview && ['review', 'pr-review-risk'].includes(resolvedTask.task_intent)
          ? 'source-review'
          : resolvedTask.task_intent,
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
      const initialGraphContextFreshness = analyzeGraphContextFreshness(graphPath, graph)
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

      // Change reviews and impact use separate pack shapes. Source reviews use
      // normal retrieval, so they support its resolution and strategy options.
      const earlyResolutionParam = helpers.stringParam(toolArguments, 'resolution')
      if (earlyResolutionParam && (changesReview || task === 'impact')) {
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
      if (changesReview && contextPackStrategy) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'retrieval_strategy is not supported for task=review')
      }

      const contextPackLevelOverride = helpers.numberParamAlias(toolArguments, ['retrieval_level', 'retrievalLevel'], { min: 0, max: 5 })
      if ((Object.hasOwn(toolArguments, 'retrieval_level') || Object.hasOwn(toolArguments, 'retrievalLevel')) && contextPackLevelOverride === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'retrieval_level must be an integer between 0 and 5')
      }
      const contextPackLevelTyped = contextPackLevelOverride === null ? null : (contextPackLevelOverride as 0 | 1 | 2 | 3 | 4 | 5)
      const resolution = parseContextPackResolution(earlyResolutionParam)
      const includeSelectionDiagnostics = toolArguments.verbose === true
      const requestedSource = resolution === 'detail'
        ? { rootPath: resolveGraphSourceRoot(graphPath, graph), prompt } : undefined
      const deltaSessionId = helpers.stringParamAlias(toolArguments, ['delta_session_id', 'deltaSessionId'])
      const sourceContinuationOptions = (task === 'explain' || task === 'implement')
        && resolution === 'detail' && !includeSelectionDiagnostics && !deltaSessionId
        ? { rootPath: resolveGraphSourceRoot(graphPath, graph),
            store: (handleId: string, handle: SourceContinuationHandle) => helpers.setContextPackHandle(handleId, handle) }
        : undefined
      const packagePaths = !deltaSessionId && task === 'explain'
        ? graph.nodeEntries().map(([, node]) => String(node.source_file ?? '')).filter(isPackageManifestPath) : []
      const packageRoot = resolveGraphSourceRoot(graphPath, graph)
      const packageSnapshot = (): PackageSourceSnapshot | null => packagePaths.length
        ? capturePackageSourceSnapshot(packagePaths, packageRoot) : null
      const packageConfiguration = packageSnapshot()
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
            const cachedRecord: unknown = JSON.parse(cachedPayloadText)
            if (!isObjectRecord(cachedRecord) || cachedRecord.version !== 1
              || !Object.hasOwn(cachedRecord, 'source_configuration')
              || !Object.hasOwn(cachedRecord, 'package_configuration')
              || !isCachedExplainContextPackPayload(cachedRecord.payload)) {
              throw new Error('Malformed cached explain context_pack payload')
            }
            if (cachedRecord.source_configuration !== null
              && !sourceModuleConfigurationSnapshotIsFresh(
                cachedRecord.source_configuration,
                resolveGraphSourceRoot(graphPath, graph),
              )) {
              throw new Error('Source module configuration changed')
            }
            if (!packageSourceSnapshotsMatch(cachedRecord.package_configuration, packageConfiguration)) {
              throw new Error('Indexed package source or policy changed')
            }
            const cachedPayload = cachedRecord.payload
            const cachedGraphFreshness = analyzeGraphContextFreshness(graphPath, graph, {
              selected_source_files: selectedContextSourceFilesFromCachedExplainPayload(cachedPayload),
            })
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
            const cachedBundles = cachedSourceCallsites(cachedRecord.source_callsites)
            const cachedReferences = cachedSourceFunctionValues(cachedRecord.source_function_values)
            const cachedCatalog = cachedSourceFlowCatalog(cachedRecord.source_flow_catalog)
            const cachedFlowBudget = cachedCatalog ? { catalog: cachedCatalog,
              lookup: (handleId: string) => helpers.getContextPackHandle(handleId),
              store: (handleId: string, handle: unknown) => helpers.setContextPackHandle(handleId, handle) } : undefined
            const cachedFunctionValues = requestedSource && !includeSelectionDiagnostics
              && (!contextPackStrategy || contextPackStrategy === 'default')
              && cachedRecord.source_configuration !== null && cachedReferences.length
              ? { references: cachedReferences,
                  configurationFresh: () => sourceModuleConfigurationSnapshotIsFresh(cachedRecord.source_configuration, packageRoot) }
              : undefined
            const cachedCallsites = requestedSource && !includeSelectionDiagnostics
              && (!contextPackStrategy || contextPackStrategy === 'default')
              && cachedRecord.source_configuration !== null && cachedBundles.length
              ? { bundles: cachedBundles,
                  configurationFresh: () => sourceModuleConfigurationSnapshotIsFresh(cachedRecord.source_configuration, packageRoot) }
              : undefined
            const cachedText = JSON.stringify(finalizeGeneratedContextPackResponse(withContextPackCache(cachedWithFreshness, {
              status: 'hit',
              graph_version: cacheGraphVersion!,
            }), resolvedBudget, { verbose: includeSelectionDiagnostics, sourcePolicyRoot: packageRoot, ...(requestedSource ? { requestedSource } : {}),
              ...(cachedCallsites ? { callsites: cachedCallsites } : {}),
              ...(cachedFunctionValues ? { functionValues: cachedFunctionValues } : {}),
              ...(cachedCallsites && cachedFlowBudget ? { flowBudget: cachedFlowBudget } : {}),
              ...(sourceContinuationOptions ? { continuations: sourceContinuationOptions } : {}) },
              { prompt: cachedPayload.prompt, task: 'explain', taskIntent: cachedPayload.task_intent, helpers,
                ...(isObjectRecord(cachedRecord.source_coherent_continuation)
                  ? { sourceCatalog: cachedRecord.source_coherent_continuation as unknown as SourceCoherentContinuationCatalog } : {}) }))
            if (!packageSourceSnapshotsMatch(packageConfiguration, packageSnapshot())) throw new Error('Indexed package source changed during cache hydration')
            return helpers.ok(id, helpers.textToolResult(cachedText))
          } catch {
            helpers.clearContextPackCache(cacheKey)
          }
        }
      }

      if (changesReview) {
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
          impactTraversalSummary: prResult.impact_traversal,
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
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(finalizeSourceEvidenceResponse(payload, resolvedBudget, { verbose: includeSelectionDiagnostics, sourcePolicyRoot: packageRoot }))))
      }

      const retrieval = retrieveContext(graph, {
        question: prompt,
        budget: resolvedBudget,
        taskKind: task,
        taskIntent: initialPlan.evidence.recipe_id,
        ...(contextPackLevelTyped !== null ? { retrievalLevel: contextPackLevelTyped } : {}),
        ...(contextPackStrategy ? { retrievalStrategy: contextPackStrategy } : {}),
      })
      const sourceConfiguration = getSourceModuleConfigurationSnapshot(retrieval.source_dependencies)
      const sourceCallsites = retrieval[sourceCallsiteBundlesKey]
      const sourceFunctionValues = retrieval[sourceFunctionValueReferencesKey]
      const sourceFlowCatalog = retrieval[sourceFlowCatalogKey]
      const flowBudget = sourceFlowCatalog ? { catalog: sourceFlowCatalog,
        lookup: (handleId: string) => helpers.getContextPackHandle(handleId),
        store: (handleId: string, handle: unknown) => helpers.setContextPackHandle(handleId, handle) } : undefined
      // Optional module-derived completion needs a fully inspected origin.
      // An incomplete snapshot must not suppress independently verified source
      // recovery; admitted snapshots still undergo the live freshness checks.
      const functionValues = task === 'explain' && resolution === 'detail' && !includeSelectionDiagnostics
        && !deltaSessionId && (!contextPackStrategy || contextPackStrategy === 'default')
        && sourceFunctionValues?.length && sourceConfiguration?.cacheable === true
        ? { references: sourceFunctionValues,
            configurationFresh: () => sourceModuleConfigurationSnapshotIsFresh(sourceConfiguration, packageRoot) }
        : undefined
      const callsites = task === 'explain' && resolution === 'detail' && !includeSelectionDiagnostics
        && !deltaSessionId && (!contextPackStrategy || contextPackStrategy === 'default')
        && sourceCallsites?.length && sourceConfiguration?.cacheable === true
        ? { bundles: sourceCallsites,
            configurationFresh: () => sourceModuleConfigurationSnapshotIsFresh(sourceConfiguration, packageRoot) }
        : undefined
      const cacheEligible = cacheKey !== null && cacheGraphVersion !== null
        && sourceConfiguration?.cacheable !== false
        && packageSourceSnapshotsMatch(packageConfiguration, packageSnapshot())
      const graphContextFreshness = analyzeGraphContextFreshness(graphPath, graph, {
        selected_source_files: selectedContextSourceFilesFromRetrieveResult(retrieval),
      })
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
          ...helpers.readStoredCommunityLabels(graphPath),
        }
        const impactTarget = pickImpactTargetIdentity(retrieval)
        const impactResult = analyzeImpact(graph, communityLabels, {
          ...impactTarget,
          depth: 3,
        })
        const impactPack = compactImpactResult(impactResult)
        const metadata = impactMetadata(impactResult, resolvedBudget, prompt, initialPlan.evidence.recipe_id, contextPackLevelTyped ?? undefined)
        const evidence = buildMadarResponseEvidence({
          coverage: metadata.coverage,
          graphPath,
          question: prompt,
          impactTraversal: impactResult.traversal,
          coveredWorkflowOwners: collectWorkflowOwners(
            impactResult.target_file ? [impactResult.target_file] : [],
            impactResult.affected_files ?? [],
          ),
        })
        const payload = constrainStrictContextPackPayload(withContextPackGovernance({
          ...contextPackBasePayload(task, prompt, resolvedBudget, graphPath, initialPlan),
          target: impactTarget.label,
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
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(finalizeSourceEvidenceResponse(payload, resolvedBudget, { verbose: includeSelectionDiagnostics, sourcePolicyRoot: packageRoot }))))
      }

      const fullPack = contextPackFromRetrieveResult(retrieval)
      const compactPack = compactRetrieveResult(retrieval, { snippetBudget: resolvedBudget, topNWithSnippet: retrieval.matched_nodes.length })
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
        // Resolution retains node identity and marks derived snippets,
        // removing exact-source metadata when the rendering changes.
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
        const generationReceipt = `graph:${graphFreshnessMetadata(graphPath).graphVersion ?? 'unknown'}`
        let previouslySent = helpers.getContextPackNodeIds(deltaSessionId)
        if (!previouslySent.includes(generationReceipt) || previouslySent.length > 2048) {
          helpers.clearContextPackNodeIds(deltaSessionId)
          previouslySent = []
        }
        // Receipts describe delivered representations. Render against all
        // relationships before removing anything already sent, so a repeat
        // sketch is stable and a signature never substitutes for source.
        const resolvedFullNodes = applyResolutionToNodes(fullPack.nodes, fullPack.relationships)
        const deltaResult = computeDeltaContextPack({ ...fullPack, nodes: resolvedFullNodes.nodes }, previouslySent)
        const deltaNodesStripped = deltaResult.delta_pack.nodes.map((node) => {
          const { evidence_class: _evidenceClass, ...rest } = node
          return rest
        })
        const resolvedDeltaNodes = { ...resolvedFullNodes, nodes: deltaNodesStripped }
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
            ...(retrieval.source_search ? { source_search: retrieval.source_search } : {}),
            ...(retrieval.selection_scope ? { selection_scope: retrieval.selection_scope } : {}),
            ...(retrieval.selection_omitted ? { selection_omitted: retrieval.selection_omitted } : {}),
            ...(retrieval.source_dependencies ? { source_dependencies: retrieval.source_dependencies } : {}),
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
        const finalDeltaPayload = finalizeSourceEvidenceResponse(deltaPayload, resolvedBudget, { verbose: includeSelectionDiagnostics, sourcePolicyRoot: packageRoot })
        helpers.recordContextPackNodeIds(deltaSessionId, [generationReceipt, ...collectDeliveredContextReceipts(finalDeltaPayload)])
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(finalDeltaPayload)))
      }
      const resolvedNodes = applyResolutionToNodes(compactPack.matched_nodes, compactPack.relationships)
      const discovery = task === 'explain' && resolution === 'detail' && !includeSelectionDiagnostics
        && (!contextPackStrategy || contextPackStrategy === 'default')
        ? discoverySourceDeferral(graph, graphPath, retrieval, resolvedNodes.nodes) : undefined
      const buildResponse = (deferred?: NonNullable<typeof discovery>): Record<string, unknown> => {
        const selectedNodes = deferred ? resolvedNodes.nodes.filter(node => !node.node_id || !deferred.ids.has(node.node_id)) : resolvedNodes.nodes
        const selectedIds = new Set(selectedNodes.flatMap(node => node.node_id ? [node.node_id] : []))
        const originalRelationships = (explainPayload?.pack ?? compactPack).relationships
        const selectedRelationships = deferred ? originalRelationships.filter(edge =>
          !!edge.from_id && !!edge.to_id && selectedIds.has(edge.from_id) && selectedIds.has(edge.to_id)) : originalRelationships
        const responseMetadata = deferred ? { ...metadata, expandable: [...deferred.expandable, ...metadata.expandable] } : metadata
        const retrievalPlan = reconcileSurfaceRetrievalPlan(
          (explainPayload?.pack ?? compactPack).retrieval_plan,
          prompt,
          selectedNodes,
        )
        const serializedPack = {
          ...(explainPayload?.pack ?? compactPack),
          matched_nodes: selectedNodes,
          relationships: selectedRelationships,
          ...(retrievalPlan ? { retrieval_plan: retrievalPlan } : {}),
        }
        if (deferred) {
          delete serializedPack.execution_slice; delete serializedPack.answer_contract
          Object.assign(serializedPack, { _source_discovery_deferred: true })
        }
        const evidence = evidenceForRetrievePayload({
          question: prompt,
          ...(fullPack.task_contract ? { task_contract: fullPack.task_contract } : {}),
          ...(!deferred && fullPack.coverage ? { coverage: fullPack.coverage } : {}),
          ...(!deferred && fullPack.execution_slice ? { execution_slice: fullPack.execution_slice } : {}),
          ...(!deferred && fullPack.answer_contract ? { answer_contract: fullPack.answer_contract } : {}),
          ...(deferred ? { expandable: responseMetadata.expandable } : fullPack.expandable ? { expandable: fullPack.expandable } : {}),
          ...(!deferred && fullPack.recovery ? { recovery: fullPack.recovery } : {}),
          matched_nodes: selectedNodes,
          relationships: serializedPack.relationships,
        }, graphPath)
        if (deferred) {
          evidence.coverage = 'partial'
          evidence.answerability = { ...evidence.answerability, state: 'insufficient', answer_scope: 'partial', advisory: true,
            // Withholding aggregate coverage must not describe visible retained
            // source as absent. Original uncertainty is merged below as before.
            caveats: [...evidence.answerability.caveats.filter(caveat => selectedNodes.length === 0
              || caveat !== 'no selected evidence; verify the exact target'),
              'Secondary source bodies are deferred to the supplied expandable handles.'] }
          evidence.agent_directive = 'explore_with_caution'
        }
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
          ...responseMetadata,
          evidence,
        }, {
          graphFreshness: graphContextFreshness,
          task,
          taskIntent: initialPlan.evidence.recipe_id,
          budget: resolvedBudget,
          evidence,
          expandable: responseMetadata.expandable,
          ...(contextPackStrategy ? { retrievalStrategy: contextPackStrategy } : {}),
          resolution,
          cacheEligible,
          cacheStatus: cacheEligible ? 'miss' : 'bypass',
        })
        if (deferred) { delete (basePayload as Record<string, unknown>).coverage; delete (basePayload as Record<string, unknown>).claims }
        applySourceLexicalCaution(basePayload)
        return constrainStrictContextPackPayload(basePayload, helpers)
      }
      let responsePayload = buildResponse()
      const freshness = isObjectRecord(responsePayload.governance) && isObjectRecord(responsePayload.governance.graph_freshness)
        ? responsePayload.governance.graph_freshness : {}
      const blocked = isObjectRecord(responsePayload.evidence) && isObjectRecord(responsePayload.evidence.answerability)
        && responsePayload.evidence.answerability.broad_search_fallback === 'blocked'
      if (discovery && !blocked && freshness.status === 'fresh' && freshness.selected_context_status === 'fresh') {
        const compact = buildResponse(discovery)
        const originalEvidence = responsePayload.evidence as ReturnType<typeof evidenceForRetrievePayload>
        const compactEvidence = compact.evidence as ReturnType<typeof evidenceForRetrievePayload>
        compactEvidence.answerability.missing_obligations = [...new Set([...originalEvidence.answerability.missing_obligations,
          ...compactEvidence.answerability.missing_obligations])]
        compactEvidence.answerability.caveats = [...new Set([...originalEvidence.answerability.caveats, ...compactEvidence.answerability.caveats])]
        // Pure wire preflight: never remove source unless every promised generic
        // continuation survives serialization. No packing or source fill occurs.
        const wireInput = (input: Record<string, unknown>): Record<string, unknown> => cacheEligible && cacheKey && cacheGraphVersion
          ? withContextPackCache(input, { status: 'miss', graph_version: cacheGraphVersion }) : input
        const preview = serializeSourceEvidenceResponse(wireInput(compact), resolvedBudget)
        const exposed = new Set(Array.isArray(preview.expandable) ? preview.expandable.flatMap(entry =>
          isObjectRecord(entry) && typeof entry.handle_id === 'string' ? [entry.handle_id] : []) : [])
        const previewPack = isObjectRecord(preview.pack) ? preview.pack : {}
        const retained = new Set(Array.isArray(previewPack.matched_nodes) ? previewPack.matched_nodes.flatMap(node =>
          isObjectRecord(node) && typeof node.node_id === 'string' ? [node.node_id] : []) : [])
        const expected = resolvedNodes.nodes.filter(node => node.node_id && !discovery.ids.has(node.node_id))
        const originalPreview = serializeSourceEvidenceResponse(wireInput(responsePayload), resolvedBudget)
        if (discovery.expandable.every(entry => exposed.has(entry.handle_id))
          && discovery.expandable.every(entry => !entry.symbols || (Array.isArray(preview.expandable)
            && preview.expandable.some(value => isObjectRecord(value) && value.handle_id === entry.handle_id
              && JSON.stringify(value.symbols) === JSON.stringify(entry.symbols))))
          && expected.every(node => retained.has(node.node_id!))
          && estimateQueryTokens(JSON.stringify(preview)) < estimateQueryTokens(JSON.stringify(originalPreview))) responsePayload = compact
      }
      const responseContext = { prompt, task, taskIntent: initialPlan.evidence.recipe_id, helpers,
        ...(task === 'explain' && resolution === 'detail' && !deltaSessionId && !includeSelectionDiagnostics
          && (!contextPackStrategy || contextPackStrategy === 'default')
          ? { sourceCatalog: retrieval[sourceCoherentContinuationCatalogKey] } : {}) }
      if (!cacheEligible || !cacheKey || !cacheGraphVersion) {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(finalizeGeneratedContextPackResponse(responsePayload, resolvedBudget, {
          verbose: includeSelectionDiagnostics, sourcePolicyRoot: packageRoot,
          ...(requestedSource ? { requestedSource } : {}),
          ...(task === 'implement' && resolution === 'detail' ? { sourceRoot: resolveGraphSourceRoot(graphPath, graph) } : {}),
          ...(callsites ? { callsites } : {}),
          ...(functionValues ? { functionValues } : {}),
          ...(callsites && flowBudget ? { flowBudget } : {}),
          ...(sourceContinuationOptions ? { continuations: sourceContinuationOptions } : {}),
        }, responseContext))))
      }
      const payloadText = JSON.stringify(finalizeGeneratedContextPackResponse(withContextPackCache(responsePayload, {
        status: 'miss',
        graph_version: cacheGraphVersion,
      }), resolvedBudget, { verbose: includeSelectionDiagnostics, sourcePolicyRoot: packageRoot, ...(requestedSource ? { requestedSource } : {}),
        ...(callsites ? { callsites } : {}),
        ...(functionValues ? { functionValues } : {}),
        ...(callsites && flowBudget ? { flowBudget } : {}),
        ...(sourceContinuationOptions ? { continuations: sourceContinuationOptions } : {}) }, responseContext))
      // Cache the complete internal payload so a cache hit can be freshly serialized,
      // rechecked for drift and given exactly the same final budget contract.
      // Resolution depends on compiler configuration as well as delivered source.
      // Keep its fingerprints in the process cache, outside the wire payload.
      const cacheRecord: CachedExplainContextPackRecord = {
        version: 1,
        payload: responsePayload as CachedExplainContextPackPayload,
        source_configuration: sourceConfiguration ?? null,
        package_configuration: packageConfiguration,
        ...(sourceFlowCatalog ? { source_flow_catalog: sourceFlowCatalog } : {}),
        ...(responseContext.sourceCatalog ? { source_coherent_continuation: responseContext.sourceCatalog } : {}),
        ...(callsites ? { source_callsites: {
          source_dependencies: callsites.bundles[0]!.source_dependencies,
          bundles: callsites.bundles.map(({ source_dependencies: _inputs, ...bundle }) => bundle),
        } } : {}),
        ...(functionValues ? { source_function_values: {
          source_dependencies: functionValues.references[0]!.source_dependencies,
          references: functionValues.references.map(({ source_dependencies: _inputs, ...reference }) => reference),
        } } : {}),
      }
      if (packageSourceSnapshotsMatch(packageConfiguration, packageSnapshot())) {
        helpers.setContextPackCache(cacheKey, JSON.stringify(cacheRecord))
      } else {
        helpers.clearContextPackCache(cacheKey)
      }
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
      const hasSymbol = Object.hasOwn(toolArguments, 'symbol')
      const symbol = typeof toolArguments.symbol === 'string' ? toolArguments.symbol.trim() : undefined
      if (hasSymbol && (typeof toolArguments.symbol !== 'string' || !symbol || toolArguments.symbol.length > helpers.maxStdioTextLength)) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_expand symbol must be a non-empty string <= ${helpers.maxStdioTextLength} characters`)
      }
      const budget = helpers.numberParamAlias(toolArguments, ['budget'], { min: MIN_SOURCE_EVIDENCE_BUDGET, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && budget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between ${MIN_SOURCE_EVIDENCE_BUDGET} and ${helpers.maxStdioTokenBudget}`)
      }
      const stored = helpers.getContextPackHandle(handleId)
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        const message = helpers.strictContextPackMode
          ? `Unknown context_pack handle_id '${handleId}'. Use a returned source_expand_handle or expandable handle from this MCP session.`
          : `Unknown context_pack handle_id '${handleId}'. Expand handles are only available within the MCP session that produced them.`
        return helpers.failure(id, helpers.jsonrpcInvalidParams, message)
      }
      if (isSourceGroupContinuation(stored)) {
        if (hasSymbol) return helpers.failure(id, helpers.jsonrpcInvalidParams, 'context_expand symbol cannot change a source group cursor')
        try {
          const expanded = expandSourceGroupContinuation(stored, handleId, budget ?? 1500, resolveGraphSourceRoot(graphPath, graph), {
            graph_freshness: analyzeGraphContextFreshness(graphPath, graph,
              { selected_source_files: stored.catalog.source_dependencies.map(source => source.source_file) }),
          })
          if (expanded.child) helpers.setContextPackHandle(expanded.child.id, expanded.child.handle)
          return helpers.ok(id, helpers.textToolResult(JSON.stringify(expanded.payload)))
        } catch (error) {
          return helpers.failure(id, helpers.jsonrpcServerError,
            error instanceof Error ? error.message : 'Source group continuation could not verify its source. Re-run context_pack.')
        }
      }
      if (isSourceContinuationHandle(stored)) {
        if (hasSymbol) return helpers.failure(id, helpers.jsonrpcInvalidParams, 'context_expand symbol is only supported for generic expandable handles, not source_expand_handle')
        try {
          const rootPath = resolveGraphSourceRoot(graphPath, graph)
          const partition = (stored as unknown as Record<string, unknown>).source_recovery_partition as SourceRecoveryPartition | undefined
          if (partition !== undefined) verifySourceRecoveryPartition(partition, rootPath)
          const expanded = expandSourceContinuation(stored, budget ?? 1500, resolveGraphSourceRoot(graphPath, graph), {
            graph_freshness: analyzeGraphContextFreshness(graphPath, graph, { selected_source_files: [stored.source_file] }),
          })
          if (partition !== undefined) {
            const staged = new Map<string, unknown>()
            if (expanded.child) staged.set(expanded.child.id, expanded.child.handle)
            const payload = partitionRecoveryReferences(expanded.payload, partition, rootPath, staged, helpers.getContextPackHandle)
            const filtered = filterSourceRecoveryResponse(payload, partition, budget ?? 1500, { expectedRoot: rootPath,
              lookupSourceHandle: id => {
                const handle = staged.get(id) ?? helpers.getContextPackHandle(id)
                return isSourceContinuationHandle(handle) ? handle : undefined
              } })
            filtered.validate()
            publishRecoveryHandles(filtered.payload, staged, helpers)
            return helpers.ok(id, helpers.textToolResult(JSON.stringify(filtered.payload)))
          }
          if (expanded.child) helpers.setContextPackHandle(expanded.child.id, expanded.child.handle)
          return helpers.ok(id, helpers.textToolResult(JSON.stringify(expanded.payload)))
        } catch (error) {
          return helpers.failure(id, helpers.jsonrpcServerError,
            error instanceof Error ? error.message : 'Source continuation could not verify its source. Re-run context_pack.')
        }
      }
      if (!isStoredContextPackHandle(stored)) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Malformed context_pack handle_id '${handleId}'. Re-run context_pack and retry context_expand within the same MCP session.`)
      }

      if (stored.explicit_target) {
        try {
          const target = stored.explicit_target
          if (typeof target.node_id !== 'string' || typeof target.symbol !== 'string') {
            throw new FocusedSymbolError('Malformed explicit source target handle; request a fresh context_pack', true)
          }
          const owner = focusedSymbolOwner(graph, graphPath, stored, symbol ?? target.symbol)
          if (owner.nodeId !== target.node_id) throw new FocusedSymbolError('Explicit target handle cannot select a different source owner', true)
          const expanded = beginSourceContinuation({ node_id: owner.nodeId,
            label: String(graph.nodeAttributes(owner.nodeId).label), source_file: owner.sourceFile,
            range: { start_line: owner.range.start, end_line: owner.range.end }, snippet: owner.snippet,
          }, { task: stored.task, task_intent: stored.task_intent,
            evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
              caveats: ['Explicit target lookup verifies only the requested source owners; it does not establish whole-task completeness.'] } },
            governance: { graph_freshness: analyzeGraphContextFreshness(graphPath, graph, { selected_source_files: [owner.sourceFile] }) },
          }, budget ?? 1500, resolveGraphSourceRoot(graphPath, graph))
          owner.validate()
          if (expanded.child) helpers.setContextPackHandle(expanded.child.id, expanded.child.handle)
          return helpers.ok(id, helpers.textToolResult(JSON.stringify(expanded.payload)))
        } catch (error) {
          return helpers.failure(id, error instanceof FocusedSymbolError && error.invalidParams ? helpers.jsonrpcInvalidParams : helpers.jsonrpcServerError,
            error instanceof Error ? error.message : 'Explicit source target could not verify its owner; request a fresh context_pack')
        }
      }

      try {
        const selectedSymbol = symbol ? focusedSymbolOwner(graph, graphPath, stored, symbol) : undefined
        // A symbol explicitly requests a reread. Ordinary omission traversal
        // follows the immutable partition advertised with its original pack.
        const partition = selectedSymbol ? undefined : stored.source_recovery_partition
        const rootPath = resolveGraphSourceRoot(graphPath, graph)
        if (partition !== undefined) verifySourceRecoveryPartition(partition, rootPath)
        const stagedHandles = new Map<string, unknown>()
        const expansionHelpers = { ...helpers,
          setContextPackHandle: (nextId: string, handle: unknown) => { stagedHandles.set(nextId, handle) },
        }
        const preparedExpansion = prepareFocusedExpansionPayload(graph, graphPath, handleId, stored,
          budget ?? 1500, expansionHelpers, selectedSymbol)
        const payload = constrainStrictContextExpansionPayload(
          preparedExpansion.build(preparedExpansion.candidates, expansionHelpers), helpers)
        if (selectedSymbol && isObjectRecord(payload.evidence)) {
          const prior = isObjectRecord(payload.evidence.answerability) ? payload.evidence.answerability : {}
          payload.evidence.answerability = { ...prior, state: 'insufficient', answer_scope: 'partial', advisory: true,
            caveats: [...(Array.isArray(prior.caveats) ? prior.caveats : []), 'Symbol expansion verifies one source owner; original task completeness is not reassessed.'] }
          payload.evidence.agent_directive = 'explore_with_caution'
        }
        const expansionFiles = isObjectRecord(payload.pack) && Array.isArray(payload.pack.matched_nodes)
          ? payload.pack.matched_nodes.flatMap(node => isObjectRecord(node) && typeof node.source_file === 'string' ? [node.source_file] : []) : []
        payload.governance = { graph_freshness: analyzeGraphContextFreshness(graphPath, graph, { selected_source_files: expansionFiles }) }
        const expansionOptions = {
          verbose: toolArguments.verbose === true,
          requestedSource: { rootPath: resolveGraphSourceRoot(graphPath, graph), prompt: stored.prompt },
          continuations: { rootPath: resolveGraphSourceRoot(graphPath, graph),
            store: (nextId: string, handle: SourceContinuationHandle) => expansionHelpers.setContextPackHandle(nextId, handle) },
        }
        let expanded: Record<string, unknown>
        try {
          expanded = selectedSymbol ? finalizeSourceEvidenceResponse(payload, budget ?? 1500, expansionOptions)
            : finalizeGeneratedContextPackResponse(payload, budget ?? 1500, expansionOptions,
              { prompt: stored.prompt, task: stored.task, taskIntent: stored.task_intent, helpers: expansionHelpers })
        } catch (error) {
          if (selectedSymbol || !stored.follow_up.node_ids?.length || toolArguments.verbose === true
            || !(error instanceof Error) || !error.message.startsWith('Budget ')) throw error
          expanded = { ...payload, pack: { matched_nodes: [], relationships: [] } }
        }
        const finalPack = isObjectRecord(expanded.pack) ? expanded.pack : {}
        const finalNodes = Array.isArray(finalPack.matched_nodes) ? finalPack.matched_nodes : []
        const budgetOmission = isObjectRecord(expanded.omitted_evidence)
          ? expanded.omitted_evidence.reason === 'output_budget'
          : typeof expanded.omitted_evidence === 'string' && expanded.omitted_evidence.startsWith('output_budget;')
        const originalEvidence = isObjectRecord(payload.evidence) ? payload.evidence : {}
        const originalAnswer = isObjectRecord(originalEvidence.answerability) ? originalEvidence.answerability : {}
        if (selectedSymbol && toolArguments.verbose !== true && budgetOmission
          && originalAnswer.broad_search_fallback !== 'blocked'
          && !finalNodes.some(node => isObjectRecord(node) && node.node_id === selectedSymbol.nodeId)) {
          selectedSymbol.validate()
          const compactEvidence = isObjectRecord(expanded.evidence) ? expanded.evidence : {}
          const compactAnswer = isObjectRecord(compactEvidence.answerability) ? compactEvidence.answerability : {}
          const evidence = { ...compactEvidence, answerability: { ...compactAnswer,
            broad_search_fallback: originalAnswer.broad_search_fallback,
            caveats: [...new Set([...stringValues(originalAnswer.caveats), ...stringValues(compactAnswer.caveats)])],
            missing_obligations: [...new Set([...stringValues(originalAnswer.missing_obligations), ...stringValues(compactAnswer.missing_obligations)])],
            // The abandoned response's staged navigation is not part of this page.
            verification_targets: Array.isArray(compactAnswer.verification_targets)
              ? compactAnswer.verification_targets.filter(target => !isObjectRecord(target) || typeof target.handle_id !== 'string') : [],
          } }
          const firstPage = beginSourceContinuation({ node_id: selectedSymbol.nodeId,
            label: String(graph.nodeAttributes(selectedSymbol.nodeId).label), source_file: selectedSymbol.sourceFile,
            range: { start_line: selectedSymbol.range.start, end_line: selectedSymbol.range.end }, snippet: selectedSymbol.snippet,
          }, { task: stored.task, task_intent: stored.task_intent, evidence,
            governance: isObjectRecord(expanded.governance) ? expanded.governance : payload.governance },
          budget ?? 1500, resolveGraphSourceRoot(graphPath, graph))
          expanded = firstPage.payload
          stagedHandles.clear()
          if (firstPage.child) stagedHandles.set(firstPage.child.id, firstPage.child.handle)
        }
        selectedSymbol?.validate()
        if (partition !== undefined) {
          expanded = partitionRecoveryReferences(expanded, partition, rootPath, stagedHandles, helpers.getContextPackHandle)
          const filtered = filterSourceRecoveryResponse(expanded, partition, budget ?? 1500, { expectedRoot: rootPath,
            lookupSourceHandle: id => {
              const handle = stagedHandles.get(id) ?? helpers.getContextPackHandle(id)
              return isSourceContinuationHandle(handle) ? handle : undefined
            } })
          expanded = filtered.payload
          filtered.validate()
        }
        const sourceNodes = isObjectRecord(expanded.pack) && Array.isArray(expanded.pack.matched_nodes)
          ? expanded.pack.matched_nodes.filter(isObjectRecord) : []
        if (!selectedSymbol && stored.follow_up.node_ids?.length && toolArguments.verbose !== true
          && !sourceNodes.some(node => typeof node.snippet === 'string' && node.snippet_unverified !== true
            && node.snippet_source !== 'derived' && node.snippet.replace(/\[omitted lines \d+-\d+\]/g, '').trim().length > 0)
          // Graph-only navigation has no source allocation to retry. Inspect
          // only the same four cached entries the bounded retry can attempt;
          // actual source admission still requires all retry freshness proofs.
          && preparedExpansion.candidates.slice(0, 4).some(candidate => {
            const node = candidate.build_entry()
            return typeof node.snippet === 'string' && node.snippet_unverified !== true
              && node.snippet_source !== 'derived' && node.snippet.replace(/\[omitted lines \d+-\d+\]/g, '').trim().length > 0
          })) {
          const retried = retryEmptyOwnedExpansion(expanded, payload, handleId, stored, budget ?? 1500, rootPath,
            preparedExpansion.candidates, (candidate, trialHelpers) => {
              const trial = preparedExpansion.build([candidate], trialHelpers)
              trial.governance = { graph_freshness: analyzeGraphContextFreshness(graphPath, graph,
                { selected_source_files: typeof candidate.source_file === 'string' ? [candidate.source_file] : [] }) }
              return trial
            }, expansionHelpers, expansionOptions)
          expanded = retried.payload
          stagedHandles.clear()
          for (const [nextId, handle] of retried.handles) stagedHandles.set(nextId, handle)
        }
        publishRecoveryHandles(expanded, stagedHandles, helpers)
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(expanded)))
      } catch (error) {
        if (!hasSymbol && !(error instanceof FocusedSymbolError)) throw error
        return helpers.failure(id, error instanceof FocusedSymbolError && error.invalidParams ? helpers.jsonrpcInvalidParams : helpers.jsonrpcServerError,
          error instanceof Error ? error.message : 'context_expand symbol could not verify its source; request a fresh context_pack')
      }
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
      const initialGraphFreshness = analyzeGraphContextFreshness(graphPath, graph)
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
      })
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
        evidence: evidenceForRetrievePayload(retrieval, graphPath),
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
        evidence: evidenceForPathPayload(result, graphPath, question),
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
        evidence: evidenceForPathPayload(result, graphPath, question),
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
        evidence: evidenceForPathPayload(result, graphPath, question),
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
        evidence: evidenceForPathPayload(result, graphPath, question),
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
