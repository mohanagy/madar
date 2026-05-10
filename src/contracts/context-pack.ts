import type { RetrievalGateDecision } from './retrieval-gate.js'
import type { TaskIntentKind } from './task-intent.js'

export type ContextPackTaskKind = 'explain' | 'review' | 'impact'

export type ContextPackEvidenceClass = 'primary' | 'supporting' | 'structural' | 'change' | 'impact'

export type ContextPackSemanticCategory =
  | 'implementation'
  | 'changes'
  | 'impact'
  | 'tests'
  | 'configuration'
  | 'contracts'
  | 'structure'

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
  evidence_class?: ContextPackEvidenceClass | undefined
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
  /**
   * Retrieval-gate decision (#75) attached when the caller invoked the
   * gate before building the pack. Carries `level`, `reason`, `intent`,
   * `skipped_retrieval`, and the underlying signals so consumers can
   * audit why a retrieval depth was chosen.
   */
  retrieval_gate?: RetrievalGateDecision
}
