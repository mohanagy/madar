import type {
  RetrievalExcludedDomain,
  RetrievalGateDecision,
  RetrievalGenerationIntent,
  RetrievalIntent,
  RetrievalLevel,
  RetrievalTargetDomainHint,
} from './retrieval-gate.js'
import type { TaskIntentKind } from './task-intent.js'
import type { ContextPackDiagnosticWarning } from './context-pack-diagnostics.js'
import type { SourceDomain } from '../shared/source-discovery.js'
import type { TaskContextPlan } from './task-context-plan.js'

export type ContextPackTaskKind = 'explain' | 'implement' | 'review' | 'impact'
export type ContextPackFormat = 'json' | 'text'

export type ContextPackEvidenceClass = 'primary' | 'supporting' | 'structural' | 'change' | 'impact'

export type ContextPackSemanticCategory =
  | 'implementation'
  | 'changes'
  | 'impact'
  | 'tests'
  | 'configuration'
  | 'contracts'
  | 'structure'

export interface ContextPackSelectionRankingEntry {
  id: string
  label: string
  evidence_class: ContextPackEvidenceClass
  score: number
  token_cost: number
  density: number
  included: boolean
  reasons: string[]
  penalties: string[]
}

export interface ContextPackSelectionDiagnostics {
  selection_strategy: 'evidence-order' | 'value-per-token'
  budget: number
  used_tokens: number
  required_overflow: boolean
  ranking: ContextPackSelectionRankingEntry[]
}

export type ContextPackRetrievalStrategy = 'default' | 'slice-v1'

export interface ContextPackRoutingDebugAnchor {
  label: string
  reason: string
}

export interface ContextPackRoutingDebugExclusions {
  domains: RetrievalExcludedDomain[]
  terms: string[]
  path_hints: string[]
}

export interface ContextPackRoutingDebug {
  detected_intent: RetrievalIntent
  generation_intent: RetrievalGenerationIntent
  target_domain_hint: RetrievalTargetDomainHint
  retrieval_level: RetrievalLevel
  effective_retrieval_strategy: ContextPackRetrievalStrategy
  reason: string
  top_anchors: ContextPackRoutingDebugAnchor[]
  exclusions: ContextPackRoutingDebugExclusions
  warnings: ContextPackDiagnosticWarning[]
}

export interface ContextPackSliceAnchor {
  node_id?: string
  label: string
  reason: string
}

export interface ContextPackSlicePath {
  from_id?: string
  from: string
  to_id?: string
  to: string
  relation: string
  direction: 'forward' | 'backward'
}

export interface ContextPackSliceMetadata {
  mode: 'explain' | 'debug' | 'impact' | 'review'
  anchors: ContextPackSliceAnchor[]
  directions: Array<'forward' | 'backward'>
  selected_paths: ContextPackSlicePath[]
}

export type ContextPackExecutionPhase =
  | 'controller'
  | 'service'
  | 'validation'
  | 'auth_guard'
  | 'orchestrator'
  | 'planner'
  | 'queue'
  | 'worker'
  | 'external_research_or_api'
  | 'report_builder'
  | 'scoring'
  | 'quality_gate'
  | 'renderer_or_synthesis'
  | 'persistence'
  | 'notification_or_event'

export interface ContextPackExecutionSliceStep {
  node_id?: string
  label: string
  source_file: string
  line_number: number
  node_kind?: string
  framework_role?: string
}

export interface ContextPackExecutionSliceBoundary {
  from?: string
  to?: string
  relation: string
}

export interface ContextPackExecutionSliceBranch {
  steps: ContextPackExecutionSliceStep[]
  boundary_reason?: string
}

export interface ContextPackExecutionSliceOmittedBranch {
  from?: string
  to?: string
  relation?: string
  reason?: string
}

export interface ContextPackExecutionSlicePrimaryPath {
  steps: ContextPackExecutionSliceStep[]
  boundaries?: ContextPackExecutionSliceBoundary[]
  boundary_reason?: string
}

export interface ContextPackExecutionSlicePhaseCoverage {
  expected: ContextPackExecutionPhase[]
  observed: ContextPackExecutionPhase[]
  missing: ContextPackExecutionPhase[]
}

export interface ContextPackExecutionSlice {
  status: 'complete' | 'partial'
  confidence?: 'high' | 'medium' | 'low'
  confidence_reasons?: string[]
  boundary_reason?: string
  steps: ContextPackExecutionSliceStep[]
  primary_path?: ContextPackExecutionSlicePrimaryPath
  side_effects?: ContextPackExecutionSliceBranch[]
  terminal_boundaries?: ContextPackExecutionSliceBranch[]
  omitted_branches?: ContextPackExecutionSliceOmittedBranch[]
  phase_coverage?: ContextPackExecutionSlicePhaseCoverage
}

export interface ContextPackRuntimeGenerationAnswerContract {
  version: 1
  answer_focus: 'runtime_generation'
  entrypoint_scope: 'setup_context'
  required_elements: string[]
  do_not_claim: string[]
  observed_phases: ContextPackExecutionPhase[]
  missing_phases: ContextPackExecutionPhase[]
  uncertainty_notes?: string[]
  confidence?: 'high' | 'medium' | 'low'
}

export interface ImplementationPackFileHint {
  path: string
  why: string
  matched_symbols: string[]
}

export interface ImplementationPackSurfaceHint {
  label: string
  source_file: string
  line_number: number
  kind: 'contract' | 'public_surface' | 'pattern'
  why: string
}

export interface ImplementationPackRiskBoundary {
  label: string
  severity: 'high' | 'medium' | 'low'
  reason: string
  affected_files: string[]
  affected_communities: string[]
}

export interface ImplementationPackRuntimeContext {
  summary: string
  execution_slice?: ContextPackExecutionSlice
  answer_contract?: ContextPackRuntimeGenerationAnswerContract
}

export interface ImplementationPackGuidance {
  summary: string
  likely_edit_files: ImplementationPackFileHint[]
  likely_test_files: ImplementationPackFileHint[]
  contracts_and_public_surfaces: ImplementationPackSurfaceHint[]
  existing_patterns: ImplementationPackSurfaceHint[]
  risk_boundaries: ImplementationPackRiskBoundary[]
  validation_commands: string[]
  acceptance_criteria_summary: string[]
  cautions: string[]
  runtime_context_if_relevant?: ImplementationPackRuntimeContext
}

export interface ContextPackWorkflowCenter {
  label: string
  node_count?: number
  reason: string
}

export interface ContextPackRecommendedFirstRead {
  path: string
  label?: string
  reason: string
}

export interface ContextPackPublicContract {
  label: string
  source_file: string
  line_number: number
  kind: 'contract' | 'public_surface'
  why: string
}

export type ContextRepresentationType =
  | 'detail'
  | 'summary'
  | 'signature'
  | 'behavior_sketch'
  | 'dependency_record'
  | 'call_chain'
  | 'contract_view'
  | 'implementation_excerpt'

export interface ContextPackTaskContract {
  version: 1
  task_kind: ContextPackTaskKind
  task_intent?: TaskIntentKind
  evidence_recipe_id: TaskIntentKind
  budget: number
  prompt?: string
  required_evidence: ContextPackEvidenceClass[]
  preferred_evidence: ContextPackEvidenceClass[]
  semantic_required: ContextPackSemanticCategory[]
  semantic_optional: ContextPackSemanticCategory[]
}

export interface ContextPackNode {
  node_id?: string | undefined
  label: string
  source_file: string
  line_number: number
  snippet: string | null
  file_type?: string | undefined
  match_score?: number | undefined
  relevance_band?: 'direct' | 'related' | 'peripheral' | undefined
  community?: number | null | undefined
  community_label?: string | null | undefined
  node_kind?: string | undefined
  framework?: string | undefined
  framework_role?: string | undefined
  framework_boost?: number | undefined
  source_domain?: SourceDomain | undefined
  evidence_class?: ContextPackEvidenceClass | undefined
  representation_type?: ContextRepresentationType | undefined
  representation_reason?: string | undefined
}

export interface ContextPackRelationship {
  from_id?: string
  from: string
  to_id?: string
  to: string
  relation: string
}

export interface ContextPackCommunityContext {
  id: number
  label: string
  node_count: number
}

export interface ContextPackGraphSignals {
  god_nodes: string[]
  bridge_nodes: string[]
}

export interface ContextPackClaim {
  evidence_class: ContextPackEvidenceClass
  text: string
  node_labels: string[]
}

export interface ContextPackExpandableLineRange {
  start_line: number
  end_line: number
}

export interface ContextPackExpandablePreview {
  node_id?: string
  label: string
  source_file: string
  line_range?: ContextPackExpandableLineRange
}

export interface ContextPackExpandableSourceRange extends ContextPackExpandableLineRange {
  source_file: string
}

export interface ContextPackExpandableFollowUp {
  kind: 'context_pack'
  task_kind: ContextPackTaskKind
  evidence_class: ContextPackEvidenceClass
  focus_files: string[]
  focus_ranges: ContextPackExpandableSourceRange[]
}

export interface ContextPackExpandableRef {
  kind: 'nodes'
  handle_id: string
  evidence_class: ContextPackEvidenceClass
  count: number
  preview: ContextPackExpandablePreview[]
  follow_up: ContextPackExpandableFollowUp
}

export type ContextPackCoverageStatus = 'covered' | 'missing' | 'available'

export interface ContextPackCoverageEntry {
  evidence_class: ContextPackEvidenceClass
  required: boolean
  available_nodes: number
  selected_nodes: number
  status: ContextPackCoverageStatus
}

export interface ContextPackSemanticCoverageEntry {
  category: ContextPackSemanticCategory
  label: string
  required: boolean
  available_nodes: number
  selected_nodes: number
  status: ContextPackCoverageStatus
}

export interface ContextPackCoverage {
  required_evidence: ContextPackEvidenceClass[]
  semantic_required: ContextPackSemanticCategory[]
  semantic_optional: ContextPackSemanticCategory[]
  entries: ContextPackCoverageEntry[]
  semantic_entries: ContextPackSemanticCoverageEntry[]
  missing_required: ContextPackEvidenceClass[]
  missing_semantic: ContextPackSemanticCategory[]
  available_relationships: number
  selected_relationships: number
}

export interface CompiledContextPack<
  TNode extends ContextPackNode = ContextPackNode,
  TRelationship extends ContextPackRelationship = ContextPackRelationship,
  TCommunity extends ContextPackCommunityContext = ContextPackCommunityContext,
> {
  task_contract: ContextPackTaskContract
  token_count: number
  nodes: TNode[]
  relationships: TRelationship[]
  community_context: TCommunity[]
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage: ContextPackCoverage
  graph_signals?: ContextPackGraphSignals
  shared_file_type?: string
  selection_diagnostics?: ContextPackSelectionDiagnostics
  retrieval_strategy?: ContextPackRetrievalStrategy
  slice?: ContextPackSliceMetadata
  execution_slice?: ContextPackExecutionSlice
  answer_contract?: ContextPackRuntimeGenerationAnswerContract
  /**
   * Retrieval-gate decision (#75) attached when the caller invoked the
   * gate before building the pack. Carries `level`, `reason`, `intent`,
   * `skipped_retrieval`, and the underlying signals so consumers can
   * audit why a retrieval depth was chosen.
   */
  retrieval_gate?: RetrievalGateDecision
}

export interface ContextPackSchemaV1<TPack = unknown> {
  schema_version: 1
  task: ContextPackTaskKind
  task_intent: TaskIntentKind
  prompt: string
  budget: number
  graph_path: string
  plan: TaskContextPlan
  workflow_centers: ContextPackWorkflowCenter[]
  recommended_first_read: ContextPackRecommendedFirstRead[]
  likely_edit_files: ImplementationPackFileHint[]
  likely_test_files: ImplementationPackFileHint[]
  public_contracts: ContextPackPublicContract[]
  risk_boundaries: ImplementationPackRiskBoundary[]
  validation_commands: string[]
  negative_guidance: string[]
  confidence_score: number
  why_explanation: string[]
  pack: TPack
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage: ContextPackCoverage
  missing_context: ContextPackEvidenceClass[]
  missing_semantic: ContextPackSemanticCategory[]
  retrieval_gate?: RetrievalGateDecision
  routing?: ContextPackRoutingDebug
}
