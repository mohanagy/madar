import { buildCommunityLabels } from '../pipeline/community-naming.js'
import type {
  ContextPackClaim,
  ContextPackCoverage,
  ContextPackEvidenceClass,
  ContextPackExecutionSliceStep,
  ContextPackExpandableRef,
  ContextPackFormat,
  ImplementationPackGuidance,
  ContextPackNode,
  ContextPackPublicContract,
  ContextPackRoutingDebug,
  ContextPackSchemaV1,
  ContextPackSelectionDiagnostics,
  ContextPackWorkflowCenter,
  ContextPackRecommendedFirstRead,
} from '../contracts/context-pack.js'
import type { KnowledgeGraph } from '../contracts/graph.js'
import type { TaskContextPlan } from '../contracts/task-context-plan.js'
import type { PackCliOptions } from '../cli/parser.js'
import { classifyTaskContract, compileContextPack, estimateContextPackEntryTokens, type ContextPackNodeCandidate } from '../runtime/context-pack.js'
import type { RetrievalGateDecision } from '../contracts/retrieval-gate.js'
import { classifyRetrievalLevel } from '../runtime/retrieval-gate.js'
import { pickImpactTarget } from '../runtime/context-pack-target.js'
import { analyzeImpact, compactImpactResult, type ImpactResult } from '../runtime/impact.js'
import { analyzePrImpact, compactPrImpactResult, type PrImpactResult } from '../runtime/pr-impact.js'
import { buildTaskContextPlan } from '../runtime/task-context-planner.js'
import { resolveTaskSelection } from '../runtime/task-intent.js'
import { compactRetrieveResult, retrieveContext, type RetrieveResult } from '../runtime/retrieve.js'
import { buildImplementationPackGuidance } from '../runtime/implementation-pack.js'
import {
  agentDirectiveForEvidence,
  assessMadarResponseEvidence,
  collectWorkflowOwners,
  missingPhasesFromPayload,
  type MadarResponseEvidence,
} from '../runtime/mcp-response-evidence.js'
import { buildContextPackGovernanceReceipt } from '../runtime/context-pack-governance.js'
import { analyzeGraphContextFreshness,
graphFreshnessStatusLabel,
requireFreshGraph,
requireFreshSelectedContext,
selectedContextSourceFilesFromRetrieveResult,
type GraphContextFreshness,
} from '../runtime/freshness.js'
import { buildRoutingDebug } from '../runtime/routing-debug.js'
import { communitiesFromGraph, estimateQueryTokens, loadGraph } from '../runtime/serve.js'

const DEFAULT_IMPACT_DEPTH = 3
const IMPLEMENTATION_DISTRACTOR_PATTERN = /(?:helper|util|formatter|serializer|mapper|constant|generated|dist\/|build\/|lockfile|migration)/i
const ADAPTER_DIRECTIVE_CONFIDENCE_THRESHOLD = 0.5
const RUNTIME_GENERATION_DISTRACTOR_PATTERN = /(?:helper|util|formatter|serializer|mapper|constant|status|display|render|renderer|summary|footer|header|view|score|scoring|suggest(?:ed)?|next[-_\s]?steps)/i

export interface ContextPackCommandDependencies {
  loadGraph: (graphPath: string) => KnowledgeGraph
  retrieveContext: (graph: KnowledgeGraph, options: Pick<import('../runtime/retrieve.js').RetrieveOptions, 'question' | 'budget' | 'taskKind' | 'taskIntent' | 'retrievalLevel' | 'retrievalStrategy'>) => RetrieveResult
  compactRetrieveResult: typeof compactRetrieveResult
  analyzePrImpact: (graph: KnowledgeGraph, projectDir?: string, options?: { baseBranch?: string; depth?: number; budget?: number; taskIntent?: TaskContextPlan['evidence']['recipe_id'] }) => PrImpactResult
  compactPrImpactResult: typeof compactPrImpactResult
  analyzeImpact: (graph: KnowledgeGraph, communityLabels: Record<number, string>, options: { label: string; depth?: number }) => ImpactResult
  compactImpactResult: typeof compactImpactResult
}

const DEFAULT_DEPENDENCIES: ContextPackCommandDependencies = {
  loadGraph,
  retrieveContext: (graph, options) => retrieveContext(graph, options),
  compactRetrieveResult,
  analyzePrImpact,
  compactPrImpactResult,
  analyzeImpact,
  compactImpactResult,
}

interface ContextPlaneMetadata {
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage: ContextPackCoverage
  missing_context: ContextPackEvidenceClass[]
  missing_semantic: ContextPackCoverage['missing_semantic']
  retrieval_gate?: RetrievalGateDecision
}

export interface ExplainPackPayload extends ContextPlaneMetadata {
  pack: RetrievePackPayload & Partial<PackGuidanceCompatibilityFields>
  implementation?: ImplementationPackGuidance
  routing?: ContextPackRoutingDebug
}

type RetrievePackPayload = ReturnType<typeof compactRetrieveResult>
type ReviewPackPayload = ReturnType<typeof compactPrImpactResult>
type ImpactPackPayload = ReturnType<typeof compactImpactResult>
type PackPayload = RetrievePackPayload | ReviewPackPayload | ImpactPackPayload

type PackResponseBase = ReturnType<typeof baseResponse>

type PackSchemaEnvelope<TPack extends PackPayload = PackPayload> = ContextPackSchemaV1<TPack> & PackResponseBase & {
  evidence: MadarResponseEvidence
  implementation?: ImplementationPackGuidance
  target?: string
}

interface PackGuidanceCompatibilityFields {
  workflow_centers: ContextPackWorkflowCenter[]
  recommended_first_read: ContextPackRecommendedFirstRead[]
  confidence_score: number
}

type PackPayloadWithCompatibility<TPack extends PackPayload> = TPack & PackGuidanceCompatibilityFields

interface SerializedBudgetReport {
  max_tokens: number
  token_count: number
  enforced: boolean
}

type JsonRecord = Record<string, unknown>

const ANSWER_READY_MATCHED_NODE_CAP = 8
const ANSWER_READY_RELATIONSHIP_CAP = 12
const ANSWER_READY_COMMUNITY_CAP = 6
const ANSWER_READY_EXPLANATION_CAP = 3
const ANSWER_READY_FIRST_READ_CAP = 3
const ANSWER_READY_WORKFLOW_CENTER_CAP = 4
const WORKFLOW_SPINE_BUDGET_REASON = 'budget too tight for workflow spine'

interface AnswerReadyCullCandidate {
  key: string
  nodeId: string | null
  label: string | null
  density: number
  rankIndex: number
  preserved: boolean
}

interface AnswerReadyCullSummary {
  droppedNodeIds: string[]
  droppedWorkflowSpine: boolean
}

function packWithCompatibilityFields<TPack extends PackPayload>(
  pack: TPack,
  fields: PackGuidanceCompatibilityFields,
): PackPayloadWithCompatibility<TPack> {
  return {
    ...pack,
    ...fields,
  }
}

function packForSchema<TPack extends PackPayload>(
  task: TaskContextPlan['task_kind'],
  pack: TPack,
  fields: PackGuidanceCompatibilityFields,
): TPack | PackPayloadWithCompatibility<TPack> {
  if (task !== 'explain') {
    return pack
  }

  return packWithCompatibilityFields(pack, fields)
}

function cloneJsonRecord(value: object): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord
}

function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function runtimePrimaryPathRecordKey(record: JsonRecord | null): string | null {
  if (!record) {
    return null
  }
  if (typeof record.node_id === 'string' && record.node_id.length > 0) {
    return `id:${record.node_id}`
  }
  if (typeof record.label !== 'string' || record.label.length === 0) {
    return null
  }
  const sourceFile = typeof record.source_file === 'string' ? record.source_file : ''
  return `label:${record.label}::${sourceFile}`
}

function runtimePrimaryPathPreviewEntry(record: JsonRecord): JsonRecord | null {
  if (typeof record.label !== 'string' || record.label.length === 0) {
    return null
  }
  if (typeof record.source_file !== 'string' || record.source_file.length === 0) {
    return null
  }
  return {
    ...(typeof record.node_id === 'string' && record.node_id.length > 0 ? { node_id: record.node_id } : {}),
    label: record.label,
    source_file: record.source_file,
    ...(typeof record.line_number === 'number'
      ? {
          line_range: {
            start_line: record.line_number,
            end_line: record.line_number,
          },
        }
      : {}),
  }
}

function trimArrayField(record: JsonRecord, field: string, cap: number, trimmedFields: string[]): void {
  const values = asUnknownArray(record[field])
  if (values.length <= cap) {
    return
  }
  record[field] = values.slice(0, cap)
  trimmedFields.push(field)
}

function deleteEmptyArrayField(record: JsonRecord, field: string, trimmedFields: string[]): void {
  const values = asUnknownArray(record[field])
  if (values.length > 0) {
    return
  }
  delete record[field]
  trimmedFields.push(field)
}

function answerReadyNodeKey(record: JsonRecord | null): string | null {
  if (!record) {
    return null
  }
  if (typeof record.node_id === 'string' && record.node_id.length > 0) {
    return `id:${record.node_id}`
  }
  if (typeof record.label !== 'string' || record.label.length === 0) {
    return null
  }
  if (typeof record.source_file === 'string' && record.source_file.length > 0) {
    return `label:${record.label}::${record.source_file}`
  }
  return `label:${record.label}`
}

function collectWorkflowAnchorKeys(payload: JsonRecord): Set<string> {
  const keys = new Set<string>()
  for (const field of ['workflow_centers', 'recommended_first_read']) {
    for (const entry of asUnknownArray(payload[field])) {
      const record = asJsonRecord(entry)
      if (!record || typeof record.label !== 'string' || record.label.length === 0) {
        continue
      }
      if (typeof record.path === 'string' && record.path.length > 0) {
        keys.add(`label:${record.label}::${record.path}`)
      }
      keys.add(`label:${record.label}`)
    }
  }
  const pack = asJsonRecord(payload.pack)
  const executionSlice = asJsonRecord(pack?.execution_slice)
  const executionAnchors = [
    ...asUnknownArray(executionSlice?.steps),
    ...asUnknownArray(asJsonRecord(executionSlice?.primary_path)?.steps),
  ]
  for (const entry of executionAnchors) {
    const record = asJsonRecord(entry)
    if (!record || typeof record.label !== 'string' || record.label.length === 0) {
      continue
    }
    if (typeof record.source_file === 'string' && record.source_file.length > 0) {
      keys.add(`label:${record.label}::${record.source_file}`)
    }
    keys.add(`label:${record.label}`)
  }
  if (keys.size === 0) {
    for (const entry of asUnknownArray(payload.claims)) {
      const record = asJsonRecord(entry)
      if (!record) {
        continue
      }
      for (const label of asUnknownArray(record.node_labels)) {
        if (typeof label === 'string' && label.length > 0) {
          keys.add(`label:${label}`)
        }
      }
    }
  }
  return keys
}

function selectionRankingForNode(
  record: JsonRecord,
  diagnostics: ContextPackSelectionDiagnostics | undefined,
): { density: number; rankIndex: number } {
  if (!diagnostics) {
    return {
      density: Number.POSITIVE_INFINITY,
      rankIndex: Number.POSITIVE_INFINITY,
    }
  }
  const nodeId = typeof record.node_id === 'string' ? record.node_id : null
  const label = typeof record.label === 'string' ? record.label : null
  const byId = nodeId
    ? diagnostics.ranking.findIndex((entry) => entry.id === nodeId)
    : -1
  if (byId >= 0) {
    return {
      density: diagnostics.ranking[byId]?.density ?? Number.POSITIVE_INFINITY,
      rankIndex: byId,
    }
  }
  const byLabel = label
    ? diagnostics.ranking.findIndex((entry) => entry.label === label)
    : -1
  if (byLabel >= 0) {
    return {
      density: diagnostics.ranking[byLabel]?.density ?? Number.POSITIVE_INFINITY,
      rankIndex: byLabel,
    }
  }
  return {
    density: Number.POSITIVE_INFINITY,
    rankIndex: Number.POSITIVE_INFINITY,
  }
}

function buildAnswerReadyCullCandidates(
  payload: JsonRecord,
  pack: JsonRecord,
  diagnostics: ContextPackSelectionDiagnostics | undefined,
): AnswerReadyCullCandidate[] {
  const anchorKeys = collectWorkflowAnchorKeys(payload)
  const strategy = diagnostics?.selection_strategy ?? 'value-per-token'
  const candidates = asUnknownArray(pack.matched_nodes)
    .map((entry) => asJsonRecord(entry))
    .filter((record): record is JsonRecord => record !== null)
    .flatMap((record): AnswerReadyCullCandidate[] => {
      const key = answerReadyNodeKey(record)
      if (!key) {
        return []
      }
      const { density, rankIndex } = selectionRankingForNode(record, diagnostics)
      return [{
        key,
        nodeId: typeof record.node_id === 'string' ? record.node_id : null,
        label: typeof record.label === 'string' ? record.label : null,
        density,
        rankIndex,
        preserved: anchorKeys.has(key) || (typeof record.label === 'string' && anchorKeys.has(`label:${record.label}`)),
      }]
    })

  return candidates.sort((left, right) => {
    if (left.preserved !== right.preserved) {
      return left.preserved ? 1 : -1
    }
    if (strategy === 'evidence-order') {
      if (left.rankIndex !== right.rankIndex) {
        return right.rankIndex - left.rankIndex
      }
      return left.density - right.density
    }
    if (left.density !== right.density) {
      return left.density - right.density
    }
    return right.rankIndex - left.rankIndex
  })
}

function stripExpandableFocusRanges(payload: JsonRecord, trimmedFields: string[]): boolean {
  let stripped = false
  for (const entry of asUnknownArray(payload.expandable)) {
    const record = asJsonRecord(entry)
    const followUp = asJsonRecord(record?.follow_up)
    const focusRanges = asUnknownArray(followUp?.focus_ranges)
    if (!followUp || focusRanges.length === 0) {
      continue
    }
    delete followUp.focus_ranges
    stripped = true
  }
  if (stripped) {
    trimmedFields.push('expandable.follow_up.focus_ranges')
  }
  return stripped
}

function compactAnswerReadyPack(pack: JsonRecord, trimmedFields: string[]): void {
  delete pack.workflow_centers
  delete pack.recommended_first_read
  delete pack.confidence_score
  trimmedFields.push('pack.workflow_centers', 'pack.recommended_first_read', 'pack.confidence_score')

  const slice = asJsonRecord(pack.slice)
  if (slice) {
    const selectedPaths = asUnknownArray(slice.selected_paths)
    if (selectedPaths.length > 0) {
      delete slice.selected_paths
      slice.selected_path_count = selectedPaths.length
      trimmedFields.push('pack.slice.selected_paths')
    }
  }

  const executionSlice = asJsonRecord(pack.execution_slice)
  if (executionSlice) {
    const sideEffects = asUnknownArray(executionSlice.side_effects)
    if (sideEffects.length > 0) {
      delete executionSlice.side_effects
      executionSlice.side_effect_count = sideEffects.length
      trimmedFields.push('pack.execution_slice.side_effects')
    }
    const terminalBoundaries = asUnknownArray(executionSlice.terminal_boundaries)
    if (terminalBoundaries.length > 0) {
      delete executionSlice.terminal_boundaries
      executionSlice.terminal_boundary_count = terminalBoundaries.length
      trimmedFields.push('pack.execution_slice.terminal_boundaries')
    }
    const omittedBranches = asUnknownArray(executionSlice.omitted_branches)
    if (omittedBranches.length > 0) {
      delete executionSlice.omitted_branches
      executionSlice.omitted_branch_count = omittedBranches.length
      trimmedFields.push('pack.execution_slice.omitted_branches')
    }
  }

  trimArrayField(pack, 'matched_nodes', ANSWER_READY_MATCHED_NODE_CAP, trimmedFields)
  trimArrayField(pack, 'relationships', ANSWER_READY_RELATIONSHIP_CAP, trimmedFields)
  trimArrayField(pack, 'community_context', ANSWER_READY_COMMUNITY_CAP, trimmedFields)
}

function compactAnswerReadyGovernance(payload: JsonRecord, trimmedFields: string[]): void {
  const governance = asJsonRecord(payload.governance)
  if (!governance) {
    return
  }
  const surface = typeof governance.surface === 'string' ? governance.surface : null

  const graphFreshness = asJsonRecord(governance.graph_freshness)
  if (graphFreshness) {
    if (typeof graphFreshness.graph_path === 'string') {
      delete graphFreshness.graph_path
      trimmedFields.push('governance.graph_freshness.graph_path')
    }
    if (typeof graphFreshness.graph_version === 'string') {
      delete graphFreshness.graph_version
      trimmedFields.push('governance.graph_freshness.graph_version')
    }
    if (typeof graphFreshness.graph_modified_at === 'string') {
      delete graphFreshness.graph_modified_at
      trimmedFields.push('governance.graph_freshness.graph_modified_at')
    }
    if (typeof graphFreshness.graph_modified_ms === 'number') {
      delete graphFreshness.graph_modified_ms
      trimmedFields.push('governance.graph_freshness.graph_modified_ms')
    }
    if (typeof graphFreshness.generated_ms === 'number') {
      delete graphFreshness.generated_ms
      trimmedFields.push('governance.graph_freshness.generated_ms')
    }
    if (typeof graphFreshness.generated_at === 'string') {
      delete graphFreshness.generated_at
      trimmedFields.push('governance.graph_freshness.generated_at')
    }
    if (typeof graphFreshness.madar_version === 'string') {
      delete graphFreshness.madar_version
      trimmedFields.push('governance.graph_freshness.madar_version')
    }
    if (typeof graphFreshness.recommendation === 'string') {
      delete graphFreshness.recommendation
      trimmedFields.push('governance.graph_freshness.recommendation')
    }
  }

  const privacyBoundary = asJsonRecord(governance.privacy_boundary)
  if (privacyBoundary) {
    for (const field of ['includes_prompt', 'includes_source_content', 'includes_answer_content', 'includes_file_paths']) {
      if (Object.hasOwn(privacyBoundary, field)) {
        delete privacyBoundary[field]
        trimmedFields.push(`governance.privacy_boundary.${field}`)
      }
    }
  }

  const request = asJsonRecord(governance.request)
  if (request) {
    if (typeof request.budget === 'number') {
      delete request.budget
      trimmedFields.push('governance.request.budget')
      if (request.resolution === 'detail') {
        delete request.resolution
        trimmedFields.push('governance.request.resolution')
      }
    }
  }

  const directive = asJsonRecord(governance.directive)
  if (directive && asUnknownArray(directive.missing_phases).length === 0) {
    delete directive.missing_phases
    trimmedFields.push('governance.directive.missing_phases')
  }
  if (surface === 'cli_pack' && directive && typeof directive.coverage === 'string') {
    delete directive.coverage
    trimmedFields.push('governance.directive.coverage')
  }

  const followUp = asJsonRecord(governance.follow_up)
  if (followUp) {
    for (const field of ['expandable_evidence_classes', 'expansion_task_kinds']) {
      if (Array.isArray(followUp[field])) {
        delete followUp[field]
        trimmedFields.push(`governance.follow_up.${field}`)
      }
    }
    if (surface === 'cli_pack') {
      for (const field of ['focus_file_count', 'focus_range_count']) {
        if (typeof followUp[field] === 'number') {
          delete followUp[field]
          trimmedFields.push(`governance.follow_up.${field}`)
        }
      }
    }
  }

  if (surface === 'cli_pack') {
    const privacyBoundary = asJsonRecord(governance.privacy_boundary)
    if (privacyBoundary) {
      for (const field of ['includes_prompt', 'includes_source_content', 'includes_answer_content', 'includes_file_paths']) {
        if (typeof privacyBoundary[field] === 'boolean') {
          delete privacyBoundary[field]
          trimmedFields.push(`governance.privacy_boundary.${field}`)
        }
      }
    }
  }
}

function trimGovernanceBeforeNodeCulling(payload: JsonRecord, maxTokens: number, trimmedFields: string[]): boolean {
  const governance = asJsonRecord(payload.governance)
  if (!governance) {
    return false
  }
  const surface = typeof governance.surface === 'string' ? governance.surface : null
  if (surface !== 'cli_pack') {
    return false
  }

  const attempts: Array<() => void> = []
  const followUp = asJsonRecord(governance.follow_up)
  if (followUp) {
    attempts.push(() => {
      delete governance.follow_up
      trimmedFields.push('governance.follow_up')
    })
  }
  const directive = asJsonRecord(governance.directive)
  if (directive && (Object.hasOwn(directive, 'pack_confidence') || Object.hasOwn(directive, 'coverage'))) {
    attempts.push(() => {
      delete directive.pack_confidence
      delete directive.coverage
      trimmedFields.push('governance.directive.pack_confidence', 'governance.directive.coverage')
    })
  }

  let trimmed = false
  for (const attempt of attempts) {
    attempt()
    trimmed = true
    attachSerializedBudget(payload, maxTokens, trimmedFields)
    if (estimatedJsonTokens(payload) <= maxTokens) {
      return true
    }
  }
  return trimmed
}

function preserveTrimmedRuntimePrimaryPathPreview(pack: JsonRecord, trimmedFields: string[]): void {
  const executionSlice = asJsonRecord(pack.execution_slice)
  const primaryPath = executionSlice ? asJsonRecord(executionSlice.primary_path) : null
  const primarySteps = primaryPath ? asUnknownArray(primaryPath.steps) : []
  const matchedNodes = asUnknownArray(pack.matched_nodes)
  if (primarySteps.length === 0 || matchedNodes.length <= ANSWER_READY_MATCHED_NODE_CAP) {
    return
  }

  const primaryStepRecords = primarySteps
    .map((step) => asJsonRecord(step))
    .filter((record): record is JsonRecord => record !== null)
  if (primaryStepRecords.length === 0) {
    return
  }

  const keptKeys = new Set(
    matchedNodes
      .slice(0, ANSWER_READY_MATCHED_NODE_CAP)
      .flatMap((node) => {
        const key = runtimePrimaryPathRecordKey(asJsonRecord(node))
        return key ? [key] : []
      }),
  )
  const matchedByKey = new Map<string, JsonRecord>()
  for (const node of matchedNodes) {
    const record = asJsonRecord(node)
    const key = runtimePrimaryPathRecordKey(record)
    if (!record || !key || matchedByKey.has(key)) {
      continue
    }
    matchedByKey.set(key, record)
  }

  const preview: JsonRecord[] = primaryStepRecords.flatMap((stepRecord): JsonRecord[] => {
    const key = runtimePrimaryPathRecordKey(stepRecord)
    if (!key || keptKeys.has(key)) {
      return []
    }
    const entry = runtimePrimaryPathPreviewEntry(matchedByKey.get(key) ?? stepRecord)
    return entry ? [entry] : []
  })

  if (preview.length === 0) {
    return
  }

  const expandable = asUnknownArray(pack.expandable)
  expandable.unshift({
    kind: 'nodes',
    handle_id: 'runtime-primary-path',
    evidence_class: 'supporting',
    count: preview.length,
    preview: preview.slice(0, 3),
    follow_up: {
      kind: 'context_pack',
      task_kind: 'explain',
      evidence_class: 'supporting',
      focus_files: [...new Set(preview.map((entry) => entry.source_file))],
      focus_ranges: [],
    },
  })
  pack.expandable = expandable
  trimmedFields.push('pack.matched_nodes.primary_path_promoted_to_expandable')
}

function preserveFinalRuntimePrimaryPathPreview(
  payload: JsonRecord,
  pack: JsonRecord,
  matchedNodeCap: number,
  trimmedFields: string[],
): void {
  const executionSlice = asJsonRecord(pack.execution_slice)
  const primaryPath = executionSlice ? asJsonRecord(executionSlice.primary_path) : null
  const primarySteps = primaryPath ? asUnknownArray(primaryPath.steps) : []
  const matchedNodes = asUnknownArray(pack.matched_nodes)
  if (primarySteps.length === 0 || matchedNodes.length >= primarySteps.length) {
    return
  }

  const primaryStepRecords = primarySteps
    .map((step) => asJsonRecord(step))
    .filter((record): record is JsonRecord => record !== null)
  if (primaryStepRecords.length === 0) {
    return
  }

  const keptKeys = new Set(
    matchedNodes
      .slice(0, matchedNodeCap)
      .flatMap((node) => {
        const key = runtimePrimaryPathRecordKey(asJsonRecord(node))
        return key ? [key] : []
      }),
  )
  const existingPreviewKeys = new Set(
    asUnknownArray(payload.expandable).flatMap((entry) => {
      const record = asJsonRecord(entry)
      return asUnknownArray(record?.preview).flatMap((preview) => {
        const key = runtimePrimaryPathRecordKey(asJsonRecord(preview))
        return key ? [key] : []
      })
    }),
  )
  const matchedByKey = new Map<string, JsonRecord>()
  for (const node of matchedNodes) {
    const record = asJsonRecord(node)
    const key = runtimePrimaryPathRecordKey(record)
    if (!record || !key || matchedByKey.has(key)) {
      continue
    }
    matchedByKey.set(key, record)
  }

  const preview: JsonRecord[] = primaryStepRecords.flatMap((stepRecord): JsonRecord[] => {
    const key = runtimePrimaryPathRecordKey(stepRecord)
    if (!key || keptKeys.has(key) || existingPreviewKeys.has(key)) {
      return []
    }
    const entry = runtimePrimaryPathPreviewEntry(matchedByKey.get(key) ?? stepRecord)
    return entry ? [entry] : []
  })

  if (preview.length === 0) {
    return
  }

  const expandable = asUnknownArray(payload.expandable)
  expandable.unshift({
    kind: 'nodes',
    handle_id: `runtime-primary-path-${matchedNodeCap}`,
    evidence_class: 'supporting',
    count: preview.length,
    preview: preview.slice(0, 3),
    follow_up: {
      kind: 'context_pack',
      task_kind: 'explain',
      evidence_class: 'supporting',
      focus_files: [...new Set(preview.map((entry) => entry.source_file))],
      focus_ranges: [],
    },
  })
  payload.expandable = expandable
  trimmedFields.push(`pack.matched_nodes.primary_path_promoted_to_expandable_${matchedNodeCap}`)
}

function removeMatchedNode(pack: JsonRecord, key: string, trimmedFields: string[]): JsonRecord | null {
  const nodes = asUnknownArray(pack.matched_nodes)
  const nextNodes = nodes.filter((entry) => answerReadyNodeKey(asJsonRecord(entry)) !== key)
  if (nextNodes.length === nodes.length) {
    return null
  }
  const removed = nodes.find((entry) => answerReadyNodeKey(asJsonRecord(entry)) === key)
  pack.matched_nodes = nextNodes
  trimmedFields.push('pack.matched_nodes culled')
  return asJsonRecord(removed)
}

function filterRelationshipsToRemainingNodes(pack: JsonRecord, trimmedFields: string[]): void {
  const nodes = asUnknownArray(pack.matched_nodes)
    .map((entry) => asJsonRecord(entry))
    .filter((record): record is JsonRecord => record !== null)
  const nodeIds = new Set(nodes.flatMap((record) => typeof record.node_id === 'string' ? [record.node_id] : []))
  const labels = new Set(nodes.flatMap((record) => typeof record.label === 'string' ? [record.label] : []))
  const relationships = asUnknownArray(pack.relationships)
  const nextRelationships = relationships.filter((entry) => {
    const record = asJsonRecord(entry)
    if (!record) {
      return false
    }
    const fromId = typeof record.from_id === 'string' ? record.from_id : null
    const toId = typeof record.to_id === 'string' ? record.to_id : null
    const fromLabel = typeof record.from === 'string' ? record.from : null
    const toLabel = typeof record.to === 'string' ? record.to : null
    const fromKept = fromId ? nodeIds.has(fromId) : (fromLabel ? labels.has(fromLabel) : true)
    const toKept = toId ? nodeIds.has(toId) : (toLabel ? labels.has(toLabel) : true)
    return fromKept && toKept
  })
  if (nextRelationships.length !== relationships.length) {
    pack.relationships = nextRelationships
    trimmedFields.push('pack.relationships culled')
  }
}

function downgradeWorkflowSpineConfidence(payload: JsonRecord, trimmedFields: string[]): void {
  const evidence = asJsonRecord(payload.evidence)
  if (!evidence) {
    return
  }
  const confidenceReasons = asUnknownArray(evidence.confidence_reasons)
    .flatMap((value) => typeof value === 'string' ? [value] : [])
  if (!confidenceReasons.includes(WORKFLOW_SPINE_BUDGET_REASON)) {
    confidenceReasons.push(WORKFLOW_SPINE_BUDGET_REASON)
  }
  const coverage = typeof evidence.coverage === 'string' ? evidence.coverage : 'unknown'
  evidence.pack_confidence = 'low'
  evidence.confidence_reasons = confidenceReasons
  evidence.agent_directive = agentDirectiveForEvidence(
    'low',
    coverage === 'complete' || coverage === 'partial' || coverage === 'unknown'
      ? coverage
      : 'unknown',
  )
  trimmedFields.push('evidence.pack_confidence downgraded')
}

function upsertPackCulledWarning(payload: JsonRecord, droppedNodeIds: readonly string[]): void {
  if (droppedNodeIds.length === 0) {
    return
  }
  const routing = asJsonRecord(payload.routing)
  if (!routing) {
    return
  }
  const warnings = asUnknownArray(routing.warnings)
    .map((entry) => asJsonRecord(entry))
    .filter((record): record is JsonRecord => record !== null)
    .filter((record) => record.kind !== 'pack_culled_to_budget')
  warnings.push({
    kind: 'pack_culled_to_budget',
    severity: 'warn',
    message: 'Answer-ready payload was culled to satisfy the serialized budget.',
    detail: {
      dropped_node_ids: [...droppedNodeIds],
    },
  })
  routing.warnings = warnings
}

function enforceAnswerReadyBudget(
  payload: JsonRecord,
  maxTokens: number,
  trimmedFields: string[],
  diagnostics?: ContextPackSelectionDiagnostics,
): void {
  const summary: AnswerReadyCullSummary = {
    droppedNodeIds: [],
    droppedWorkflowSpine: false,
  }
  const pack = asJsonRecord(payload.pack)

  if (stripExpandableFocusRanges(payload, trimmedFields)) {
    attachSerializedBudget(payload, maxTokens, trimmedFields)
    if (estimatedJsonTokens(payload) <= maxTokens) {
      return
    }
  }

  if (!pack) {
    attachSerializedBudget(payload, maxTokens, trimmedFields)
    return
  }

  const candidates = buildAnswerReadyCullCandidates(payload, pack, diagnostics)
  for (const candidate of candidates) {
    upsertPackCulledWarning(payload, summary.droppedNodeIds)
    if (summary.droppedWorkflowSpine) {
      downgradeWorkflowSpineConfidence(payload, trimmedFields)
    }
    attachSerializedBudget(payload, maxTokens, trimmedFields)
    if (estimatedJsonTokens(payload) <= maxTokens) {
      return
    }

    const removed = removeMatchedNode(pack, candidate.key, trimmedFields)
    if (!removed) {
      continue
    }
    filterRelationshipsToRemainingNodes(pack, trimmedFields)
    const removedId = typeof removed.node_id === 'string'
      ? removed.node_id
      : candidate.nodeId
    if (removedId) {
      summary.droppedNodeIds.push(removedId)
    }
    if (candidate.preserved) {
      summary.droppedWorkflowSpine = true
    }
    preserveFinalRuntimePrimaryPathPreview(payload, pack, asUnknownArray(pack.matched_nodes).length, trimmedFields)
  }

  upsertPackCulledWarning(payload, summary.droppedNodeIds)
  if (summary.droppedWorkflowSpine) {
    downgradeWorkflowSpineConfidence(payload, trimmedFields)
  }
  attachSerializedBudget(payload, maxTokens, trimmedFields)
}

function estimatedJsonTokens(payload: JsonRecord): number {
  return estimateQueryTokens(JSON.stringify(payload))
}

function attachSerializedBudget(
  payload: JsonRecord,
  maxTokens: number,
  _trimmedFields: readonly string[],
): void {
  payload.serialized_budget = {
    max_tokens: maxTokens,
    token_count: 0,
    enforced: false,
  } satisfies SerializedBudgetReport

  let tokenCount = estimatedJsonTokens(payload)
  for (let index = 0; index < 2; index += 1) {
    payload.serialized_budget = {
      max_tokens: maxTokens,
      token_count: tokenCount,
      enforced: tokenCount <= maxTokens,
    } satisfies SerializedBudgetReport
    const nextTokenCount = estimatedJsonTokens(payload)
    if (nextTokenCount === tokenCount) {
      break
    }
    tokenCount = nextTokenCount
  }
  const budget = asJsonRecord(payload.serialized_budget)
  if (budget) {
    budget.token_count = tokenCount
    budget.enforced = tokenCount <= maxTokens
  }
}

export function buildAnswerReadyPackSchema(
  schema: object,
  maxTokens: number,
  selectionDiagnostics?: ContextPackSelectionDiagnostics,
): JsonRecord {
  const payload = cloneJsonRecord(schema)
  const trimmedFields: string[] = []
  if (Object.hasOwn(payload, 'diagnostics')) {
    delete payload.diagnostics
    trimmedFields.push('diagnostics')
  }
  const pack = asJsonRecord(payload.pack)
  if (pack) {
    const packFirstRead = asUnknownArray(pack.recommended_first_read)
    const payloadFirstRead = asUnknownArray(payload.recommended_first_read)
    if (payloadFirstRead.length === 0 && packFirstRead.length > 0) {
      payload.recommended_first_read = packFirstRead.slice(0, ANSWER_READY_FIRST_READ_CAP)
      trimmedFields.push('pack.recommended_first_read promoted')
    }
    const packWorkflowCenters = asUnknownArray(pack.workflow_centers)
    const payloadWorkflowCenters = asUnknownArray(payload.workflow_centers)
    if (payloadWorkflowCenters.length === 0 && packWorkflowCenters.length > 0) {
      payload.workflow_centers = packWorkflowCenters.slice(0, ANSWER_READY_WORKFLOW_CENTER_CAP)
      trimmedFields.push('pack.workflow_centers promoted')
    }
    if (!Object.hasOwn(payload, 'confidence_score') && typeof pack.confidence_score === 'number') {
      payload.confidence_score = pack.confidence_score
      trimmedFields.push('pack.confidence_score promoted')
    }
    compactAnswerReadyPack(pack, trimmedFields)
  }
  compactAnswerReadyGovernance(payload, trimmedFields)

  trimArrayField(payload, 'workflow_centers', ANSWER_READY_WORKFLOW_CENTER_CAP, trimmedFields)
  trimArrayField(payload, 'recommended_first_read', ANSWER_READY_FIRST_READ_CAP, trimmedFields)
  trimArrayField(payload, 'why_explanation', ANSWER_READY_EXPLANATION_CAP, trimmedFields)
  attachSerializedBudget(payload, maxTokens, trimmedFields)
  if (estimatedJsonTokens(payload) <= maxTokens) {
    return payload
  }

  delete payload.plan
  trimmedFields.push('plan')
  attachSerializedBudget(payload, maxTokens, trimmedFields)
  if (estimatedJsonTokens(payload) <= maxTokens) {
    return payload
  }

  delete payload.coverage
  trimmedFields.push('coverage')
  attachSerializedBudget(payload, maxTokens, trimmedFields)
  if (estimatedJsonTokens(payload) <= maxTokens) {
    return payload
  }

  delete payload.graph_path
  trimmedFields.push('graph_path')
  attachSerializedBudget(payload, maxTokens, trimmedFields)
  if (estimatedJsonTokens(payload) <= maxTokens) {
    return payload
  }

  for (const field of [
    'claims',
    'expandable',
    'missing_context',
    'missing_semantic',
    'negative_guidance',
    'likely_edit_files',
    'likely_test_files',
    'public_contracts',
    'risk_boundaries',
    'validation_commands',
  ]) {
    deleteEmptyArrayField(payload, field, trimmedFields)
  }
  attachSerializedBudget(payload, maxTokens, trimmedFields)
  if (estimatedJsonTokens(payload) <= maxTokens) {
    return payload
  }

  const evidence = asJsonRecord(payload.evidence)
  if (evidence) {
    if (Array.isArray(evidence.covered_workflow_owners)) {
      delete evidence.covered_workflow_owners
      trimmedFields.push('evidence.covered_workflow_owners')
    }
    if (Array.isArray(evidence.confidence_reasons)) {
      delete evidence.confidence_reasons
      trimmedFields.push('evidence.confidence_reasons')
    }
  }
  attachSerializedBudget(payload, maxTokens, trimmedFields)
  if (estimatedJsonTokens(payload) <= maxTokens) {
    return payload
  }

  if (pack) {
    trimArrayField(pack, 'matched_nodes', 4, trimmedFields)
    trimArrayField(pack, 'relationships', 4, trimmedFields)
    trimArrayField(pack, 'community_context', 3, trimmedFields)
  }

  if (pack) {
    preserveFinalRuntimePrimaryPathPreview(payload, pack, 4, trimmedFields)
  }
  trimArrayField(payload, 'expandable', 3, trimmedFields)
  trimArrayField(payload, 'claims', 3, trimmedFields)
  attachSerializedBudget(payload, maxTokens, trimmedFields)
  if (estimatedJsonTokens(payload) <= maxTokens) {
    return payload
  }

  if (pack) {
    delete pack.relationships
    delete pack.graph_signals
    delete pack.snippet_budget_tokens_used
    delete pack.snippet_budget_tokens_remaining
    trimmedFields.push(
      'pack.relationships',
      'pack.graph_signals',
      'pack.snippet_budget_tokens_used',
      'pack.snippet_budget_tokens_remaining',
    )
  }
  delete payload.retrieval_gate
  delete payload.why_explanation
  trimmedFields.push('retrieval_gate', 'why_explanation')
  if (trimGovernanceBeforeNodeCulling(payload, maxTokens, trimmedFields)) {
    attachSerializedBudget(payload, maxTokens, trimmedFields)
    if (estimatedJsonTokens(payload) <= maxTokens) {
      return payload
    }
  }
  enforceAnswerReadyBudget(payload, maxTokens, trimmedFields, selectionDiagnostics)
  return payload
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

export function buildExplainPackPayload(
  pack: ReturnType<typeof compactRetrieveResult>,
  retrieval: Partial<{
    claims: ContextPackClaim[]
    expandable: ContextPackExpandableRef[]
    coverage: ContextPackCoverage
    retrieval_gate: RetrievalGateDecision
  }>,
  implementation?: ImplementationPackGuidance,
): ExplainPackPayload {
  return {
    pack,
    ...(implementation ? { implementation } : {}),
    ...contextMetadata(retrieval),
  }
}

export function buildExplainPackPayloadCore(
  pack: ReturnType<typeof compactRetrieveResult>,
  retrieval: Partial<{
    question: string
    coverage: ContextPackCoverage
    task_contract: { budget: number; task_intent?: string; evidence_recipe_id?: string }
  }> & {
    question: string
  },
  implementation?: ImplementationPackGuidance,
  graphPath?: string,
): ExplainPackPayload {
  const payload = buildExplainPackPayload(pack, retrieval, implementation)
  const plan = buildTaskContextPlan({
    task_kind: 'explain',
    prompt: retrieval.question,
    budget: Math.max(retrieval.task_contract?.budget ?? 3000, 3),
    task_intent: (retrieval.task_contract?.task_intent ?? retrieval.task_contract?.evidence_recipe_id ?? 'explain') as TaskContextPlan['evidence']['recipe_id'],
  })
  const centers = workflowCenters('explain', pack, plan, implementation, retrieval as RetrieveResult)
  const firstRead = recommendedFirstRead('explain', pack, implementation, retrieval as RetrieveResult)
  const evidenceAssessment = assessMadarResponseEvidence({
    answerContract: (retrieval as RetrieveResult).answer_contract,
    coverage: payload.coverage,
    coveredWorkflowOwners: collectWorkflowOwners(
      centers.map((entry) => entry.path),
      firstRead.map((entry) => entry.path),
      implementation?.likely_edit_files.map((entry) => entry.path) ?? [],
      implementation?.likely_test_files.map((entry) => entry.path) ?? [],
    ),
    executionSlice: (retrieval as RetrieveResult).execution_slice,
    graphPath,
    missingPhases: missingPhasesFromPayload(pack as {
      answer_contract?: { missing_phases?: readonly unknown[] }
      execution_slice?: { phase_coverage?: { missing?: readonly unknown[] } }
    }),
    score: confidenceScore(payload.coverage, pack, implementation),
  })

  return {
    ...payload,
    pack: {
      ...payload.pack,
      workflow_centers: centers,
      recommended_first_read: firstRead,
      confidence_score: evidenceAssessment.score,
    },
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

  const buildEntry = (): ContextPackNode => {
    if (builtEntry) {
      return builtEntry
    }

    builtEntry = {
      label: node.label,
      source_file: node.source_file,
      line_number: 0,
      snippet: null,
      ...(node.file_type ? { file_type: node.file_type } : {}),
      ...(typeof node.community === 'number' ? { community: node.community } : {}),
      ...(node.community_label !== undefined ? { community_label: node.community_label } : {}),
      ...(node.node_kind ? { node_kind: node.node_kind } : {}),
      ...(node.framework_role ? { framework_role: node.framework_role } : {}),
      evidence_class: evidenceClass,
    }
    tokenCost = estimateContextPackEntryTokens(node.label, node.source_file, 0, null)
    return builtEntry
  }

  return {
    label: node.label,
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

function impactMetadata(
  result: ImpactResult,
  budget: number,
  prompt: string,
  taskIntent: TaskContextPlan['evidence']['recipe_id'],
  retrievalLevelOverride?: PackCliOptions['retrievalLevel'],
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

function baseResponse(
  options: PackCliOptions,
  plan: TaskContextPlan,
  budget: number,
  task: TaskContextPlan['task_kind'],
) {
  return {
    task,
    task_intent: plan.evidence.recipe_id,
    prompt: options.prompt,
    budget,
    graph_path: options.graphPath,
    plan,
  }
}

function defaultPackRetrievalStrategy(
  prompt: string,
): PackCliOptions['retrievalStrategy'] | undefined {
  const gate = classifyRetrievalLevel({
    prompt,
  })

  return gate.signals.generation_intent === 'runtime_generation'
    ? 'slice-v1'
    : undefined
}

function runtimeGenerationExecutionSpine(
  task: TaskContextPlan['task_kind'],
  pack: PackPayload,
  retrieval?: RetrieveResult,
): ContextPackExecutionSliceStep[] {
  const retrievalGate = retrieval?.retrieval_gate ?? ('retrieval_gate' in pack ? pack.retrieval_gate : undefined)
  const retrievalSteps = Array.isArray(retrieval?.execution_slice?.steps) ? retrieval.execution_slice.steps : []
  if (
    task !== 'explain'
    || retrievalGate?.signals.generation_intent !== 'runtime_generation'
  ) {
    return []
  }

  if (retrievalSteps.length > 0) {
    return retrievalSteps
  }

  if ('execution_slice' in pack && Array.isArray(pack.execution_slice?.steps) && pack.execution_slice.steps.length > 0) {
    return pack.execution_slice.steps
  }

  return []
}

function workflowCenters(
  task: TaskContextPlan['task_kind'],
  pack: PackPayload,
  plan: TaskContextPlan,
  implementation?: ImplementationPackGuidance,
  retrieval?: RetrieveResult,
): ContextPackWorkflowCenter[] {
  const fromCommunityContext = (
    entries: Array<{ label: string; node_count?: number }>,
    reason: string,
  ): ContextPackWorkflowCenter[] => entries.slice(0, 4).map((entry) => ({
    label: entry.label,
    ...(typeof entry.node_count === 'number' ? { node_count: entry.node_count } : {}),
    reason,
  }))

  if (task === 'implement' && implementation?.workflow_centers.length) {
    return implementation.workflow_centers.slice(0, 4)
  }

  const executionSpine = runtimeGenerationExecutionSpine(task, pack, retrieval)
  if (executionSpine.length > 0) {
    const centers: ContextPackWorkflowCenter[] = []
    const seen = new Set<string>()
    for (const [index, step] of executionSpine.entries()) {
      if (seen.has(step.source_file)) {
        continue
      }
      seen.add(step.source_file)
      centers.push({
        label: step.label,
        path: step.source_file,
        reason: index === 0
          ? 'Runtime-generation execution spine enters here.'
          : `Runtime-generation execution spine handoff ${index + 1} passes through this file.`,
      })
      if (centers.length >= 4) {
        break
      }
    }
    if (centers.length > 0) {
      return centers
    }
  }

  if (
    (task === 'review' || task === 'impact')
    && 'affected_communities' in pack
    && Array.isArray(pack.affected_communities)
    && pack.affected_communities.length > 0
  ) {
    return fromCommunityContext(pack.affected_communities, task === 'review'
      ? 'Changed files and their nearby impact evidence converge here.'
      : 'Impact traversal reaches this community from the selected target.')
  }

  if ('community_context' in pack && Array.isArray(pack.community_context) && pack.community_context.length > 0) {
    return fromCommunityContext(pack.community_context, 'Selected pack evidence clusters here.')
  }

  if ('review_bundle' in pack && pack.review_bundle && Array.isArray(pack.review_bundle.community_context) && pack.review_bundle.community_context.length > 0) {
    return fromCommunityContext(pack.review_bundle.community_context, 'Review bundle evidence clusters here.')
  }

  return plan.steps.slice(0, 3).map((step) => ({
    label: step.title,
    reason: `Planner step scoped as ${step.scope_mode}.`,
  }))
}

function recommendedFirstRead(
  task: TaskContextPlan['task_kind'],
  pack: PackPayload,
  implementation?: ImplementationPackGuidance,
  retrieval?: RetrieveResult,
): ContextPackRecommendedFirstRead[] {
  if (task === 'implement' && implementation) {
    const reads: ContextPackRecommendedFirstRead[] = []
    const seen = new Set<string>()
    const pushRead = (path: string, reason: string, label?: string) => {
      if (seen.has(path) || reads.length >= 3) {
        return
      }
      seen.add(path)
      reads.push({
        path,
        ...(label ? { label } : {}),
        reason,
      })
    }

    for (const center of implementation.workflow_centers) {
      if (!center.path) {
        continue
      }
      pushRead(center.path, center.reason, center.label)
    }
    for (const entry of implementation.contracts_and_public_surfaces.filter((item) => item.kind === 'public_surface')) {
      pushRead(entry.source_file, entry.why, entry.label)
    }
    for (const entry of implementation.contracts_and_public_surfaces.filter((item) => item.kind === 'contract')) {
      pushRead(entry.source_file, entry.why, entry.label)
    }
    for (const entry of implementation.existing_patterns) {
      pushRead(entry.source_file, entry.why, entry.label)
    }
    for (const entry of implementation.likely_edit_files) {
      pushRead(entry.path, entry.reason, entry.matched_symbols[0])
    }

    if (reads.length > 0) {
      return reads
    }
  }

  const executionSpine = runtimeGenerationExecutionSpine(task, pack, retrieval)
  if (executionSpine.length > 0) {
    const reads: ContextPackRecommendedFirstRead[] = []
    const seen = new Set<string>()
    for (const [index, step] of executionSpine.entries()) {
      if (seen.has(step.source_file)) {
        continue
      }
      seen.add(step.source_file)
      reads.push({
        path: step.source_file,
        label: step.label,
        reason: index === 0
          ? 'Start with the runtime-generation entrypoint.'
          : `Read this runtime-generation handoff after ${executionSpine[index - 1]?.label ?? 'the previous step'}.`,
      })
      if (reads.length >= 3) {
        break
      }
    }
    if (reads.length > 0) {
      return reads
    }
  }

  if (implementation?.likely_edit_files.length) {
    return implementation.likely_edit_files.slice(0, 3).map((entry) => ({
      path: entry.path,
      ...(entry.matched_symbols[0] ? { label: entry.matched_symbols[0] } : {}),
      reason: entry.reason,
    }))
  }

  if (task === 'review' && 'changed_files' in pack && Array.isArray(pack.changed_files) && pack.changed_files.length > 0) {
    return pack.changed_files.slice(0, 3).map((path) => ({
      path,
      reason: 'Changed file in the current diff.',
    }))
  }

  if (task === 'impact' && 'target_file' in pack && typeof pack.target_file === 'string' && pack.target_file.length > 0) {
    const reads: ContextPackRecommendedFirstRead[] = [{
      path: pack.target_file,
      ...(typeof pack.target === 'string' ? { label: pack.target } : {}),
      reason: 'Impact traversal starts from this target.',
    }]
    if (Array.isArray(pack.affected_files)) {
      for (const path of pack.affected_files) {
        if (reads.some((entry) => entry.path === path)) {
          continue
        }
        reads.push({
          path,
          reason: 'Affected file reached by the dependency traversal.',
        })
        if (reads.length >= 3) {
          break
        }
      }
    }
    return reads
  }

  if ('matched_nodes' in pack && Array.isArray(pack.matched_nodes)) {
    const reads: ContextPackRecommendedFirstRead[] = []
    const seen = new Set<string>()
    const runtimeGenerationFallback =
      task === 'explain'
      && executionSpine.length === 0
      && retrieval?.retrieval_gate?.signals.generation_intent === 'runtime_generation'
    for (const node of pack.matched_nodes) {
      if (
        runtimeGenerationFallback
        && RUNTIME_GENERATION_DISTRACTOR_PATTERN.test(`${node.label} ${node.source_file}`)
      ) {
        continue
      }
      if (seen.has(node.source_file)) {
        continue
      }
      seen.add(node.source_file)
      reads.push({
        path: node.source_file,
        label: node.label,
        reason: runtimeGenerationFallback
          ? `Fallback pack evidence via ${node.label}; verify against workflow centers and runtime handoffs.`
          : `Direct pack evidence via ${node.label}.`,
      })
      if (reads.length >= 3) {
        break
      }
    }
    return reads
  }

  if ('review_bundle' in pack && pack.review_bundle && Array.isArray(pack.review_bundle.nodes)) {
    const reads: ContextPackRecommendedFirstRead[] = []
    const seen = new Set<string>()
    for (const node of pack.review_bundle.nodes) {
      if (seen.has(node.source_file)) {
        continue
      }
      seen.add(node.source_file)
      reads.push({
        path: node.source_file,
        label: node.label,
        reason: `Review bundle evidence via ${node.label}.`,
      })
      if (reads.length >= 3) {
        break
      }
    }
    return reads
  }

  return []
}

function publicContracts(
  implementation?: ImplementationPackGuidance,
): ContextPackPublicContract[] {
  return implementation?.contracts_and_public_surfaces
    .filter((entry): entry is typeof entry & { kind: 'contract' | 'public_surface' } => entry.kind === 'contract' || entry.kind === 'public_surface')
    .slice(0, 6)
    .map((entry) => ({
      label: entry.label,
      source_file: entry.source_file,
      line_number: entry.line_number,
      kind: entry.kind,
      why: entry.why,
      ...(entry.phases?.length ? { phases: entry.phases } : {}),
    })) ?? []
}

function negativeGuidance(
  task: TaskContextPlan['task_kind'],
  coverage: ContextPackCoverage,
  pack: PackPayload,
  implementation?: ImplementationPackGuidance,
  retrieval?: RetrieveResult,
): string[] {
  const guidance = [...(implementation?.cautions ?? [])]

  if (coverage.missing_required.length > 0) {
    guidance.push(`Do not assume missing required evidence is covered: ${coverage.missing_required.join(', ')}.`)
  }
  if (coverage.missing_semantic.length > 0) {
    guidance.push(`Do not assume missing semantic categories are covered: ${coverage.missing_semantic.join(', ')}.`)
  }
  if ('answer_contract' in pack && pack.answer_contract?.do_not_claim) {
    for (const item of pack.answer_contract.do_not_claim) {
      guidance.push(`Do not claim: ${item}.`)
    }
  }
  if ('uncovered_hotspots' in pack && Array.isArray(pack.uncovered_hotspots) && pack.uncovered_hotspots.length > 0) {
    guidance.push(`Do not treat the compact review bundle as complete for uncovered hotspots: ${pack.uncovered_hotspots.slice(0, 3).map((entry) => entry.label).join(', ')}.`)
  }
  for (const pattern of implementation?.existing_patterns ?? []) {
    if (!IMPLEMENTATION_DISTRACTOR_PATTERN.test(`${pattern.label} ${pattern.source_file}`)) {
      continue
    }
    guidance.push(`Treat ${pattern.source_file} as supporting context first, not the default edit path, unless the task explicitly targets that helper or artifact.`)
  }

  const executionSpine = runtimeGenerationExecutionSpine(task, pack, retrieval)
  if (executionSpine.length > 0) {
    const spinePaths = new Set(executionSpine.map((step) => step.source_file))
    const seenPaths = new Set<string>()
    const matchedNodes = retrieval?.matched_nodes
      ?? ('matched_nodes' in pack && Array.isArray(pack.matched_nodes) ? pack.matched_nodes : [])
    for (const node of matchedNodes) {
      if (spinePaths.has(node.source_file) || seenPaths.has(node.source_file)) {
        continue
      }
      if (!RUNTIME_GENERATION_DISTRACTOR_PATTERN.test(`${node.label} ${node.source_file}`)) {
        continue
      }
      seenPaths.add(node.source_file)
      guidance.push(`Treat ${node.source_file} as supporting context first, not the primary runtime workflow spine, unless the question explicitly targets that helper or display/status surface.`)
      if (seenPaths.size >= 3) {
        break
      }
    }
  }

  return [...new Set(guidance)]
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
}

function confidenceScore(
  coverage: ContextPackCoverage,
  pack: PackPayload,
  implementation?: ImplementationPackGuidance,
): number {
  const requiredEntries = coverage.entries.filter((entry) => entry.required)
  const requiredCovered = requiredEntries.filter((entry) => entry.status === 'covered').length
  const semanticEntries = coverage.semantic_entries.filter((entry) => entry.required)
  const semanticCovered = semanticEntries.filter((entry) => entry.status === 'covered').length
  const requiredScore = requiredEntries.length > 0 ? requiredCovered / requiredEntries.length : 1
  const semanticScore = semanticEntries.length > 0 ? semanticCovered / semanticEntries.length : 1
  const relationshipScore = coverage.available_relationships > 0
    ? coverage.selected_relationships / coverage.available_relationships
    : 1

  let score = (requiredScore * 0.55) + (semanticScore * 0.3) + (relationshipScore * 0.15)

  if (implementation && implementation.likely_edit_files.length === 0) {
    score -= 0.05
  }
  score -= Math.min(0.15, coverage.missing_required.length * 0.03)
  score -= Math.min(0.1, coverage.missing_semantic.length * 0.02)

  if ('coverage_score_weighted' in pack && typeof pack.coverage_score_weighted === 'number') {
    score = (score + pack.coverage_score_weighted) / 2
  }

  return roundScore(score)
}

function whyExplanation(
  plan: TaskContextPlan,
  workflowCentersValue: readonly ContextPackWorkflowCenter[],
  firstRead: readonly ContextPackRecommendedFirstRead[],
  coverage: ContextPackCoverage,
  score: number,
  implementation?: ImplementationPackGuidance,
  confidenceReasons: readonly string[] = [],
): string[] {
  const requiredEntries = coverage.entries.filter((entry) => entry.required)
  const requiredCovered = requiredEntries.filter((entry) => entry.status === 'covered').length
  const semanticEntries = coverage.semantic_entries.filter((entry) => entry.required)
  const semanticCovered = semanticEntries.filter((entry) => entry.status === 'covered').length

  const explanations = [
    ...(implementation?.summary ? [implementation.summary] : []),
    `Planner flow: ${plan.steps.map((step) => step.title).join(' -> ')}.`,
    workflowCentersValue.length > 0
      ? `Workflow centers emphasize ${workflowCentersValue.slice(0, 3).map((entry) => entry.label).join(', ')}.`
      : 'Workflow centers fall back to the task planner because graph clustering evidence was sparse.',
    firstRead[0]
      ? `Start with ${firstRead[0].path} because ${firstRead[0].reason.toLowerCase()}`
      : 'No first-read anchor was available, so the brief leaves that section intentionally empty.',
    ...(implementation && implementation.likely_test_files.length === 0
      ? ['No related tests were identified, so the brief keeps a manual validation caution visible.']
      : []),
    `Confidence ${score.toFixed(2)} from ${requiredCovered}/${requiredEntries.length || 0} required evidence classes and ${semanticCovered}/${semanticEntries.length || 0} required semantic categories covered.`,
    ...confidenceReasons.map((reason) => `Confidence reason: ${reason}.`),
  ]

  return explanations
}

function buildPackSchemaV1<TPack extends PackPayload>(
  response: PackResponseBase & ContextPlaneMetadata & {
    pack: TPack
    graphFreshness: GraphContextFreshness
    implementation?: ImplementationPackGuidance
    routing?: ContextPackRoutingDebug
    target?: string
    retrieval?: RetrieveResult
  },
): PackSchemaEnvelope<TPack | PackPayloadWithCompatibility<TPack>> {
  const { retrieval, graphFreshness: _graphFreshness, ...serializableResponse } = response
  const centers = workflowCenters(response.task, response.pack, response.plan, response.implementation, retrieval)
  const firstRead = recommendedFirstRead(response.task, response.pack, response.implementation, retrieval)
  const contracts = publicContracts(response.implementation)
  const guidance = negativeGuidance(response.task, response.coverage, response.pack, response.implementation, retrieval)
  const evidenceAssessment = assessMadarResponseEvidence({
    answerContract: retrieval?.answer_contract ?? ('answer_contract' in response.pack ? response.pack.answer_contract : undefined),
    coverage: response.coverage,
    executionSlice: retrieval?.execution_slice ?? ('execution_slice' in response.pack ? response.pack.execution_slice : undefined),
    graphPath: response.graph_path,
    missingPhases: missingPhasesFromPayload(response.pack as {
      answer_contract?: { missing_phases?: readonly unknown[] }
      execution_slice?: { phase_coverage?: { missing?: readonly unknown[] } }
    }),
    coveredWorkflowOwners: collectWorkflowOwners(
      centers.map((entry) => entry.path),
      firstRead.map((entry) => entry.path),
      response.implementation?.likely_edit_files.map((entry) => entry.path) ?? [],
      response.implementation?.likely_test_files.map((entry) => entry.path) ?? [],
    ),
    score: confidenceScore(response.coverage, response.pack, response.implementation),
  })
  const { score, ...evidence } = evidenceAssessment
  const compatibilityFields: PackGuidanceCompatibilityFields = {
    workflow_centers: centers,
    recommended_first_read: firstRead,
    confidence_score: score,
  }
  const retrievalStrategy = retrieval?.retrieval_strategy ?? ('retrieval_strategy' in response.pack ? response.pack.retrieval_strategy : undefined)
  const governanceBase = {
    surface: 'cli_pack' as const,
    graphFreshness: response.graphFreshness,
    task: response.task,
    taskIntent: response.task_intent,
    budget: response.budget,
    evidence,
    expandable: response.expandable,
  }
  const governance = retrievalStrategy
    ? buildContextPackGovernanceReceipt({
        ...governanceBase,
        retrievalStrategy,
      })
    : buildContextPackGovernanceReceipt(governanceBase)

  return {
    schema_version: 1,
    ...serializableResponse,
    evidence,
    governance,
    pack: packForSchema(response.task, response.pack, compatibilityFields),
    workflow_centers: centers,
    recommended_first_read: firstRead,
    likely_edit_files: response.implementation?.likely_edit_files ?? [],
    likely_test_files: response.implementation?.likely_test_files ?? [],
    public_contracts: contracts,
    ...(response.implementation?.retrieval_pipeline ? { retrieval_pipeline: response.implementation.retrieval_pipeline } : {}),
    risk_boundaries: response.implementation?.risk_boundaries ?? [],
    validation_commands: response.implementation?.validation_commands ?? [],
    negative_guidance: guidance,
    confidence_score: score,
    why_explanation: whyExplanation(
      response.plan,
      centers,
      firstRead,
      response.coverage,
      score,
      response.implementation,
      evidence.confidence_reasons,
    ),
  }
}

function renderTextSection(title: string, lines: string[]): string[] {
  return [
    title,
    ...(lines.length > 0 ? lines : ['- none identified for this task.']),
    '',
  ]
}

function renderMarkdownSection(title: string, lines: string[]): string[] {
  return [
    `## ${title}`,
    '',
    ...(lines.length > 0 ? lines : ['- none identified for this task.']),
    '',
  ]
}

function formatFileHint(path: string, reason: string, label?: string): string {
  return `- ${path}${label ? ` (${label})` : ''}: ${reason}`
}

function formatScoredFileHint(entry: { path: string; score: number; reason: string; matched_symbols: string[] }): string {
  return `- ${entry.path} [${entry.score.toFixed(2)}]${entry.matched_symbols[0] ? ` (${entry.matched_symbols[0]})` : ''}: ${entry.reason}`
}

function sourceFileCountLabel(count: number): string {
  return `${count} source file${count === 1 ? '' : 's'}`
}

function selectedContextFreshnessStatusLabel(status: GraphContextFreshness['selected_context_status']): string {
  switch (status) {
    case 'possibly_stale':
      return 'possibly stale'
    default:
      return status
  }
}

function graphFreshnessSummaryLines(schema: PackSchemaEnvelope): string[] {
  const freshness = schema.governance?.graph_freshness
  if (!freshness) {
    return []
  }

  const lines = [
    `Status: ${graphFreshnessStatusLabel(freshness.status)}`,
    `Generated: ${freshness.generated_at ?? 'unknown'}`,
    `Madar version: ${freshness.madar_version}`,
    `Indexed files: ${freshness.indexed_file_count}`,
    `Selected context: ${selectedContextFreshnessStatusLabel(freshness.selected_context_status)}`,
  ]

  if (freshness.changed_source_count > 0) {
    lines.push(`Changed since graph: ${sourceFileCountLabel(freshness.changed_source_count)}`)
  }
  if (freshness.missing_source_count > 0) {
    lines.push(`Missing since graph: ${sourceFileCountLabel(freshness.missing_source_count)}`)
  }
  if (freshness.changed_selected_context_count > 0) {
    lines.push(`Changed relevant to selected context: ${sourceFileCountLabel(freshness.changed_selected_context_count)}`)
  }
  if (freshness.missing_selected_context_count > 0) {
    lines.push(`Missing from selected context: ${sourceFileCountLabel(freshness.missing_selected_context_count)}`)
  }
  if (freshness.changed_outside_selected_context_count > 0) {
    lines.push(`Changed outside selected context: ${sourceFileCountLabel(freshness.changed_outside_selected_context_count)}`)
  }
  lines.push(`Recommended: ${freshness.recommendation}`)

  return lines
}

function workflowCenterLines(schema: PackSchemaEnvelope): string[] {
  return schema.workflow_centers.map((entry) => {
    const location = entry.path
      ? `${entry.path}${typeof entry.score === 'number' ? ` [${entry.score.toFixed(2)}]` : ''}`
      : entry.label
    const label = entry.path && entry.label !== entry.path ? ` (${entry.label})` : ''
    const reason = entry.reason || entry.reasons?.[0] || 'No workflow-center rationale was provided.'
    return `- ${location}${label}: ${reason}`
  })
}

function publicContractLines(schema: PackSchemaEnvelope): string[] {
  return schema.public_contracts.map((entry) => `- ${entry.source_file}:${entry.line_number} (${entry.kind}) ${entry.label} — ${entry.why}`)
}

function riskBoundaryLines(schema: PackSchemaEnvelope): string[] {
  return schema.risk_boundaries.map((entry) => `- ${entry.label} [${entry.severity}]: ${entry.reason}`)
}

function retrievalPipelineLines(schema: PackSchemaEnvelope): string[] {
  return schema.retrieval_pipeline?.phases.map((entry) => `- ${entry.phase}: ${entry.summary}`) ?? []
}

function hasGraphBackedWorkflowCenter(schema: PackSchemaEnvelope): boolean {
  return schema.workflow_centers.some((entry) => typeof entry.path === 'string' && entry.path.trim().length > 0)
}

function hasGroundedFirstRead(schema: PackSchemaEnvelope): boolean {
  const firstRead = schema.recommended_first_read[0]
  if (!firstRead) {
    return false
  }

  return schema.likely_edit_files.some((entry) => entry.path === firstRead.path)
    || schema.public_contracts.some((entry) => entry.source_file === firstRead.path)
    || schema.workflow_centers.some((entry) => entry.path === firstRead.path)
}

function useDirectiveAdapterGuidance(schema: PackSchemaEnvelope): boolean {
  switch (schema.evidence.agent_directive) {
    case 'answer_from_pack':
      return true
    case 'verify_one_targeted_file':
    case 'explore_with_caution':
      return false
  }
}

function claudeSearchGuidanceLine(schema: PackSchemaEnvelope): string {
  if (useDirectiveAdapterGuidance(schema)) {
    return '- Do not start with a broad repo search. Use the listed files, contracts, and tests first.'
  }

  return schema.recommended_first_read.length > 0 || schema.workflow_centers.length > 0
    ? '- Use targeted verification to confirm the listed starting points before widening the search.'
    : '- Use targeted verification to identify the starting file before widening the search.'
}

function renderPackSchemaText(schema: PackSchemaEnvelope): string {
  const freshnessLines = graphFreshnessSummaryLines(schema)
  const governanceFreshness = schema.governance?.graph_freshness
  const lines = [
    'Pack Schema v1',
    `Task: ${schema.task}`,
    `Task intent: ${schema.task_intent}`,
    `Prompt: ${schema.prompt}`,
    `Budget: ${schema.budget}`,
    `Graph path: ${schema.graph_path}`,
    `Confidence score: ${schema.confidence_score.toFixed(2)}`,
    '',
    ...(freshnessLines.length > 0 && governanceFreshness
      ? [
          `Graph freshness: ${graphFreshnessStatusLabel(governanceFreshness.status)}`,
          ...freshnessLines.slice(1),
          '',
        ]
      : []),
    ...renderTextSection('Workflow centers', workflowCenterLines(schema)),
    ...renderTextSection('Retrieval pipeline', retrievalPipelineLines(schema)),
    ...renderTextSection('Recommended first read', schema.recommended_first_read.map((entry) => formatFileHint(entry.path, entry.reason, entry.label))),
    ...renderTextSection('Likely edit files', schema.likely_edit_files.map((entry) => formatScoredFileHint(entry))),
    ...renderTextSection('Likely test files', schema.likely_test_files.map((entry) => formatScoredFileHint(entry))),
    ...renderTextSection('Public contracts', publicContractLines(schema)),
    ...renderTextSection('Risk boundaries', riskBoundaryLines(schema)),
    ...renderTextSection('Validation commands', schema.validation_commands.map((entry) => `- ${entry}`)),
    ...renderTextSection('Negative guidance', schema.negative_guidance.map((entry) => `- ${entry}`)),
    ...renderTextSection('Why this pack', schema.why_explanation.map((entry) => `- ${entry}`)),
  ]

  return lines.join('\n').trimEnd()
}

function renderPackSchemaMarkdown(schema: PackSchemaEnvelope): string {
  const freshnessLines = graphFreshnessSummaryLines(schema).map((entry) => `- ${entry}`)
  const lines = [
    '# Pack Schema v1',
    '',
    `Task: ${schema.task}`,
    `Task intent: ${schema.task_intent}`,
    `Prompt: ${schema.prompt}`,
    `Budget: ${schema.budget}`,
    `Graph path: ${schema.graph_path}`,
    `Confidence score: ${schema.confidence_score.toFixed(2)}`,
    '',
    ...renderMarkdownSection('Graph freshness', freshnessLines),
    ...renderMarkdownSection('Retrieval pipeline', retrievalPipelineLines(schema)),
    ...renderMarkdownSection('Workflow centers', workflowCenterLines(schema)),
    ...renderMarkdownSection('Recommended first read', schema.recommended_first_read.map((entry) => formatFileHint(entry.path, entry.reason, entry.label))),
    ...renderMarkdownSection('Likely edit files', schema.likely_edit_files.map((entry) => formatScoredFileHint(entry))),
    ...renderMarkdownSection('Likely test files', schema.likely_test_files.map((entry) => formatScoredFileHint(entry))),
    ...renderMarkdownSection('Public contracts', publicContractLines(schema)),
    ...renderMarkdownSection('Risk boundaries', riskBoundaryLines(schema)),
    ...renderMarkdownSection('Validation commands', schema.validation_commands.map((entry) => `- ${entry}`)),
    ...renderMarkdownSection('Negative guidance', schema.negative_guidance.map((entry) => `- ${entry}`)),
    ...renderMarkdownSection('Why this pack', schema.why_explanation.map((entry) => `- ${entry}`)),
  ]

  return lines.join('\n').trimEnd()
}

function renderClaudePack(schema: PackSchemaEnvelope): string {
  const firstRead = schema.recommended_first_read.map((entry) => `- Read ${entry.path} first${entry.label ? ` (${entry.label})` : ''}: ${entry.reason}`)
  const freshnessLines = graphFreshnessSummaryLines(schema).map((entry) => `- ${entry}`)
  const lines = [
    '# Claude Code execution brief',
    '',
    `Task: ${schema.task}`,
    `Task intent: ${schema.task_intent}`,
    `Prompt: ${schema.prompt}`,
    `Confidence score: ${schema.confidence_score.toFixed(2)}`,
    '',
    '## Start here',
    '',
    ...(firstRead.length > 0
      ? firstRead
      : ['- No first-read anchor was identified; begin with the workflow centers below.']),
    claudeSearchGuidanceLine(schema),
    '',
    ...renderMarkdownSection('Graph freshness', freshnessLines),
    ...renderMarkdownSection('Retrieval pipeline', retrievalPipelineLines(schema)),
    ...renderMarkdownSection('Workflow centers', workflowCenterLines(schema)),
    ...renderMarkdownSection('Likely edit files', schema.likely_edit_files.map((entry) => formatScoredFileHint(entry))),
    ...renderMarkdownSection('Likely test files', schema.likely_test_files.map((entry) => formatScoredFileHint(entry))),
    ...renderMarkdownSection('Public contracts', publicContractLines(schema)),
    ...renderMarkdownSection('Risk boundaries', riskBoundaryLines(schema)),
    ...renderMarkdownSection('Validation commands', schema.validation_commands.map((entry) => `- ${entry}`)),
    ...renderMarkdownSection('Negative guidance', schema.negative_guidance.map((entry) => `- ${entry}`)),
    ...renderMarkdownSection('Why this pack', schema.why_explanation.map((entry) => `- ${entry}`)),
  ]

  return lines.join('\n').trimEnd()
}

function renderCopilotPlanSteps(schema: PackSchemaEnvelope): string[] {
  const steps: string[] = []
  const firstRead = schema.recommended_first_read[0]
  const primaryEdit = schema.likely_edit_files[0]
  const primaryTest = schema.likely_test_files[0]
  const directiveMode = useDirectiveAdapterGuidance(schema)

  steps.push(
    directiveMode
      ? (
          firstRead
            ? `Read \`${firstRead.path}\` first to anchor the change: ${firstRead.reason}`
            : 'Start from the top workflow center before making edits.'
        )
      : (
          firstRead
            ? 'Verify the suggested starting file against the prompt and workflow centers before editing.'
            : 'Verify the top workflow center against the prompt before making edits.'
        ),
  )
  steps.push(
    primaryEdit
      ? `Implement the change in \`${primaryEdit.path}\`: ${primaryEdit.reason}`
      : 'Use the workflow centers to identify the smallest implementation surface.',
  )
  steps.push(
    primaryTest
      ? `Update or add coverage in \`${primaryTest.path}\` once the implementation is in place.`
      : 'Add or update tests around the impacted workflow after the implementation change.',
  )
  steps.push(
    schema.validation_commands.length > 0
      ? 'Run the listed validation commands before handoff.'
      : 'Run the usual repository validation flow before handoff.',
  )

  return steps.map((step, index) => `${index + 1}. ${step}`)
}

function renderCopilotPack(schema: PackSchemaEnvelope): string {
  const freshnessLines = graphFreshnessSummaryLines(schema).map((entry) => `- ${entry}`)
  const lines = [
    '# GitHub Copilot implementation brief',
    '',
    `Task: ${schema.task}`,
    `Task intent: ${schema.task_intent}`,
    `Prompt: ${schema.prompt}`,
    `Confidence score: ${schema.confidence_score.toFixed(2)}`,
    '',
    ...renderMarkdownSection('Graph freshness', freshnessLines),
    ...renderMarkdownSection('Suggested plan', renderCopilotPlanSteps(schema)),
    ...renderMarkdownSection('Retrieval pipeline', retrievalPipelineLines(schema)),
    ...renderMarkdownSection('Workflow centers', workflowCenterLines(schema)),
    ...renderMarkdownSection('Likely edit files', schema.likely_edit_files.map((entry) => formatScoredFileHint(entry))),
    ...renderMarkdownSection('Likely test files', schema.likely_test_files.map((entry) => formatScoredFileHint(entry))),
    ...renderMarkdownSection('Public contracts', publicContractLines(schema)),
    ...renderMarkdownSection('Risk boundaries', riskBoundaryLines(schema)),
    ...renderMarkdownSection('Validation commands', schema.validation_commands.map((entry) => `- ${entry}`)),
    ...renderMarkdownSection('Negative guidance', schema.negative_guidance.map((entry) => `- ${entry}`)),
    ...renderMarkdownSection('Why this pack', schema.why_explanation.map((entry) => `- ${entry}`)),
  ]

  return lines.join('\n').trimEnd()
}

function renderContextPackOutput(
  format: ContextPackFormat | undefined,
  schema: PackSchemaEnvelope,
  options: { verbose?: boolean } = {},
): string {
  switch (format) {
    case 'text':
      return renderPackSchemaText(schema)
    case 'markdown':
      return renderPackSchemaMarkdown(schema)
    case 'claude':
      return renderClaudePack(schema)
    case 'copilot':
      return renderCopilotPack(schema)
    case 'json':
    case undefined:
      return JSON.stringify(options.verbose === true || schema.task !== 'explain' ? schema : buildAnswerReadyPackSchema(schema, schema.budget))
  }
}

export async function runContextPackCommand(
  options: PackCliOptions,
  dependencies: ContextPackCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const graph = dependencies.loadGraph(options.graphPath)
  const initialGraphFreshness = analyzeGraphContextFreshness(options.graphPath, graph)
  if (options.requireFreshGraph === true) {
    requireFreshGraph(initialGraphFreshness)
  }
  const plannerBudget = Math.max(options.budget, 3)
  const resolvedTask = resolveTaskSelection(
    options.prompt,
    options.task,
    options.taskExplicit !== undefined ? { explicit: options.taskExplicit } : {},
  )
  const initialPlan = buildTaskContextPlan({
    task_kind: resolvedTask.task_kind,
    prompt: options.prompt,
    budget: plannerBudget,
    task_intent: resolvedTask.task_intent,
  })
  const renderOptions = options.verbose === undefined ? {} : { verbose: options.verbose }

  if (resolvedTask.task_kind === 'review') {
    if (options.requireFreshContext === true) {
      throw new Error('requireFreshContext is not supported for task=review')
    }
    if (options.retrievalStrategy !== undefined) {
      throw new Error('retrievalStrategy is not supported for task=review')
    }
    const reviewResult = dependencies.analyzePrImpact(graph, '.', {
      budget: plannerBudget,
      taskIntent: initialPlan.evidence.recipe_id,
    })
    const reviewPack = dependencies.compactPrImpactResult(reviewResult)
    const plan = buildTaskContextPlan({
      task_kind: 'review',
      prompt: options.prompt,
      budget: plannerBudget,
      task_intent: initialPlan.evidence.recipe_id,
      changed_paths: reviewResult.changed_files ?? [],
      focus_paths: [
        ...(reviewResult.review_context?.supporting_paths ?? []),
        ...(reviewResult.review_context?.test_paths ?? []),
      ],
    })

    return renderContextPackOutput(options.format, buildPackSchemaV1({
      ...baseResponse(options, plan, plannerBudget, resolvedTask.task_kind),
      pack: reviewPack,
      graphFreshness: initialGraphFreshness,
      ...contextMetadata(reviewResult.review_bundle ?? {}),
    }), renderOptions)
  }

  if (resolvedTask.task_kind === 'impact') {
    const retrieval = dependencies.retrieveContext(graph, {
      question: options.prompt,
      budget: plannerBudget,
      taskKind: resolvedTask.task_kind,
      taskIntent: initialPlan.evidence.recipe_id,
      ...(options.retrievalLevel !== undefined ? { retrievalLevel: options.retrievalLevel } : {}),
      ...(options.retrievalStrategy !== undefined ? { retrievalStrategy: options.retrievalStrategy } : {}),
    })
    const impactTarget = pickImpactTarget(retrieval)
    const communityLabels = buildCommunityLabels(graph, communitiesFromGraph(graph))
    const impactResult = dependencies.analyzeImpact(graph, communityLabels, {
      label: impactTarget,
      depth: DEFAULT_IMPACT_DEPTH,
    })
    const impactPack = dependencies.compactImpactResult(impactResult)

    return renderContextPackOutput(options.format, buildPackSchemaV1({
      ...baseResponse(options, initialPlan, plannerBudget, resolvedTask.task_kind),
      target: impactTarget,
      pack: impactPack,
      graphFreshness: initialGraphFreshness,
      ...impactMetadata(impactResult, plannerBudget, options.prompt, initialPlan.evidence.recipe_id, options.retrievalLevel),
      ...(options.why ? { routing: buildRoutingDebug(retrieval) } : {}),
    }), renderOptions)
  }

  const effectivePackRetrievalStrategy =
    options.retrievalStrategy ?? defaultPackRetrievalStrategy(options.prompt)

  const retrieval = dependencies.retrieveContext(graph, {
    question: options.prompt,
    budget: plannerBudget,
    taskKind: resolvedTask.task_kind,
    taskIntent: initialPlan.evidence.recipe_id,
    ...(options.retrievalLevel !== undefined ? { retrievalLevel: options.retrievalLevel } : {}),
    ...(effectivePackRetrievalStrategy !== undefined
      ? { retrievalStrategy: effectivePackRetrievalStrategy }
      : {}),
  })
  const implementation = resolvedTask.task_kind === 'implement'
    ? buildImplementationPackGuidance(graph, retrieval, {
        budget: plannerBudget,
        taskIntent: initialPlan.evidence.recipe_id,
      })
    : undefined
  const graphFreshness = analyzeGraphContextFreshness(options.graphPath, graph, {
    selected_source_files: selectedContextSourceFilesFromRetrieveResult(retrieval),
  })
  if (options.requireFreshContext === true) {
    requireFreshSelectedContext(graphFreshness)
  }
  return renderContextPackOutput(options.format, buildPackSchemaV1({
    ...baseResponse(options, initialPlan, plannerBudget, resolvedTask.task_kind),
    graphFreshness,
    ...(
      resolvedTask.task_kind === 'explain'
        ? buildExplainPackPayloadCore(dependencies.compactRetrieveResult(retrieval), retrieval, implementation, options.graphPath)
        : buildExplainPackPayload(dependencies.compactRetrieveResult(retrieval), retrieval, implementation)
    ),
    retrieval,
    ...(options.why ? { routing: buildRoutingDebug(retrieval) } : {}),
  }), renderOptions)
}
