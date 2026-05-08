export type ContextPackTaskKind = 'explain' | 'review' | 'impact'

export type ContextPackEvidenceClass = 'primary' | 'supporting' | 'structural' | 'change' | 'impact'

export interface ContextPackTaskContract {
  version: 1
  task_kind: ContextPackTaskKind
  budget: number
  prompt?: string
  required_evidence: ContextPackEvidenceClass[]
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

export interface ContextPackExpandableRef {
  kind: 'nodes'
  evidence_class: ContextPackEvidenceClass
  count: number
  preview_labels: string[]
}

export type ContextPackCoverageStatus = 'covered' | 'missing' | 'available'

export interface ContextPackCoverageEntry {
  evidence_class: ContextPackEvidenceClass
  required: boolean
  available_nodes: number
  selected_nodes: number
  status: ContextPackCoverageStatus
}

export interface ContextPackCoverage {
  required_evidence: ContextPackEvidenceClass[]
  entries: ContextPackCoverageEntry[]
  missing_required: ContextPackEvidenceClass[]
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
}
