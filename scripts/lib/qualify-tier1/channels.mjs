// The consumer-visible evidence surface of a Madar context artifact, declared
// channel by channel.
//
// Why a declared registry rather than a hand-picked set of reads:
//
// The first #661 baseline extracted about a dozen fields. That set happened to
// cover the `impact`-shaped artifact and covered almost nothing of the
// `explain`, `plan` and `review` shapes, whose selected nodes live in
// `pack.matched_nodes`, `pack.seed_nodes` and `pack.review_bundle.nodes`. A set
// chosen by reading one artifact cannot be shown to be closed over the others,
// and a symbol the product really did surface was scored as missing.
//
// So every string-bearing channel is classified here exactly once, and
// `auditSurface` refuses to measure when the artifact presents a string channel
// this file does not classify. Closure is then a checked property of a run, not
// a claim in a comment. `ignored` is a real classification and carries its
// reason: an omission has to be argued, not merely left out.
//
// Roles:
//   path     — a repository-relative path the artifact presents as evidence
//   symbol   — a node label / symbol the artifact presents as evidence
//   snippet  — retained source text. Recorded and reported, never mined for
//              symbol tokens: substring-matching free source text is exactly the
//              fuzzy matching the frozen rubric forbids.
//   ignored  — not evidence about the target, with the reason recorded
//
// Tiers:
//   strict   — material the pack selected and presents AS its evidence
//   generous — strict plus everything the pack merely points at

/** @typedef {'path'|'symbol'|'snippet'|'ignored'} ChannelRole */

const P = (channel, tier, guard) => ({ channel, role: 'path', tier, guard })
const S = (channel, tier, guard) => ({ channel, role: 'symbol', tier, guard })

/**
 * `workflow_centers` and `top_paths_per_community` are polymorphic: for
 * node-shaped task kinds each entry is a graph node (it carries `path` and
 * `matched_symbols`), and for community-shaped ones each entry is a COMMUNITY
 * (it carries `node_count` and no path). "Users Index Test" and "Drivers S3"
 * are cluster names, not code symbols, and admitting them produced spurious
 * fabrication reports. The discriminator is the entry's own shape, so it is
 * decided from the artifact rather than from the task kind.
 */
const isNodeShaped = (entry) => entry !== null && typeof entry === 'object'
  && (typeof entry.path === 'string' || Array.isArray(entry.matched_symbols))
const SNIP = (channel) => ({ channel, role: 'snippet', tier: null })
const X = (channel, reason) => ({ channel, role: 'ignored', tier: null, reason })

export const EVIDENCE_CHANNELS = [
  // ---- selected evidence: paths ------------------------------------------
  P('.pack.target_file', 'strict'),
  P('.pack.affected_files[]', 'strict'),
  P('.pack.direct_dependents[].source_file', 'strict'),
  P('.pack.transitive_dependents[].source_file', 'strict'),
  P('.pack.matched_nodes[].source_file', 'strict'),
  P('.pack.seed_nodes[].source_file', 'strict'),
  P('.pack.review_bundle.nodes[].source_file', 'strict'),
  P('.pack.changed_files[]', 'strict'),
  P('.pack.changed_ranges[].source_file', 'strict'),
  P('.pack.execution_slice.steps[].source_file', 'strict'),
  P('.pack.execution_slice.primary_path.steps[].source_file', 'strict'),
  P('.recommended_first_read[].path', 'strict'),

  // ---- selected evidence: symbols ----------------------------------------
  S('.target', 'strict'),
  S('.pack.target', 'strict'),
  S('.pack.direct_dependents[].label', 'strict'),
  S('.pack.transitive_dependents[].label', 'strict'),
  S('.pack.matched_nodes[].label', 'strict'),
  S('.pack.seed_nodes[].label', 'strict'),
  S('.pack.review_bundle.nodes[].label', 'strict'),
  S('.pack.execution_slice.steps[].label', 'strict'),
  S('.pack.execution_slice.primary_path.steps[].label', 'strict'),
  S('.pack.relationships[].from', 'strict'),
  S('.pack.relationships[].to', 'strict'),
  S('.pack.review_bundle.relationships[].from', 'strict'),
  S('.pack.review_bundle.relationships[].to', 'strict'),
  S('.pack.slice.anchors[].label', 'strict'),
  S('.pack.slice.selected_paths[].from', 'strict'),
  S('.pack.slice.selected_paths[].to', 'strict'),
  S('.pack.top_paths_per_community[].path[]', 'strict'),
  S('.pack.per_node_impact[].node', 'strict'),
  S('.claims[].node_labels[]', 'strict'),

  // ---- pointers to further evidence: paths -------------------------------
  P('.evidence.answerability.verification_targets[].focus_files[]', 'generous'),
  P('.evidence.answerability.verification_targets[].focus_ranges[].source_file', 'generous'),
  P('.evidence.covered_workflow_owners[]', 'generous'),
  P('.expandable[].follow_up.focus_files[]', 'generous'),
  P('.expandable[].follow_up.focus_ranges[].source_file', 'generous'),
  P('.expandable[].preview[].source_file', 'generous'),
  P('.likely_edit_files[].path', 'generous'),
  P('.likely_test_files[].path', 'generous'),
  P('.workflow_centers[].path', 'generous'),
  P('.risk_boundaries[].affected_files[]', 'generous'),
  P('.implementation.likely_edit_files[].path', 'generous'),
  P('.implementation.likely_test_files[].path', 'generous'),
  P('.implementation.workflow_centers[].path', 'generous'),
  P('.implementation.risk_boundaries[].affected_files[]', 'generous'),
  P('.pack.review_context.supporting_paths[]', 'generous'),
  P('.pack.review_context.test_paths[]', 'generous'),

  // ---- pointers to further evidence: symbols -----------------------------
  S('.recommended_first_read[].label', 'generous'),
  S('.workflow_centers[].label', 'generous', isNodeShaped),
  S('.workflow_centers[].matched_symbols[]', 'generous'),
  S('.likely_edit_files[].matched_symbols[]', 'generous'),
  S('.likely_test_files[].matched_symbols[]', 'generous'),
  S('.risk_boundaries[].label', 'generous'),
  S('.implementation.workflow_centers[].label', 'generous', isNodeShaped),
  S('.implementation.workflow_centers[].matched_symbols[]', 'generous'),
  S('.implementation.likely_edit_files[].matched_symbols[]', 'generous'),
  S('.implementation.likely_test_files[].matched_symbols[]', 'generous'),
  S('.implementation.risk_boundaries[].label', 'generous'),
  S('.pack.graph_signals.god_nodes[]', 'generous'),
  S('.pack.graph_signals.bridge_nodes[]', 'generous'),
  S('.pack.risk_summary.high_impact_nodes[]', 'generous'),
  S('.pack.risk_summary.top_risks[].label', 'generous'),
  S('.pack.review_context.hotspots[].label', 'generous'),
  S('.expandable[].preview[].label', 'generous'),

  // ---- retained source text ----------------------------------------------
  SNIP('.pack.matched_nodes[].snippet'),
  SNIP('.pack.review_bundle.nodes[].snippet'),

  // ---- deliberately not evidence about the target ------------------------
  X('.prompt', 'the frozen prompt echoed back; the question is not evidence'),
  X('.plan.prompt', 'the frozen prompt echoed back; the question is not evidence'),
  X('.pack.question', 'the frozen prompt echoed back; the question is not evidence'),
  X('.retrieval_gate.signals.mentioned_paths[]', 'tokens lifted from the prompt, not retrieved from the graph'),
  X('.retrieval_gate.signals.mentioned_symbols[]', 'tokens lifted from the prompt, not retrieved from the graph'),
  X('.pack.retrieval_gate.signals.mentioned_paths[]', 'tokens lifted from the prompt, not retrieved from the graph'),
  X('.pack.retrieval_gate.signals.mentioned_symbols[]', 'tokens lifted from the prompt, not retrieved from the graph'),
  X('.retrieval_gate.signals.excluded_path_hints[]', 'exclusion hints derived from the prompt, not retrieved evidence'),
  X('.retrieval_gate.signals.excluded_terms[]', 'exclusion hints derived from the prompt, not retrieved evidence'),
  X('.pack.retrieval_gate.signals.excluded_path_hints[]', 'exclusion hints derived from the prompt, not retrieved evidence'),
  X('.pack.retrieval_gate.signals.excluded_terms[]', 'exclusion hints derived from the prompt, not retrieved evidence'),
  X('.graph_path', 'path of the graph artifact this tool wrote, not a path in the target'),

  // Typed declaration channels. These are what the frozen adjudication contract
  // reads to decide absence and unresolved state, so they must be classified
  // here or the closure guard would invalidate a cell before adjudication ever
  // ran. They are NOT evidence about the target: a pack must not earn recall by
  // describing what it could not establish.
  X('.evidence.answerability.unresolved_subjects[].subject_id', 'typed absence declaration; consumed by the adjudication contract, never as evidence'),
  X('.evidence.answerability.unresolved_subjects[].status', 'typed absence declaration status'),
  X('.evidence.answerability.unresolved_requirements[].requirement_id', 'typed unresolved declaration; consumed by the adjudication contract, never as evidence'),
  X('.evidence.answerability.unresolved_requirements[].status', 'typed unresolved declaration status'),
  X('.pack.answer_contract.absent_capabilities[].capability', 'typed absence declaration; consumed by the adjudication contract, never as evidence'),
  X('.pack.answer_contract.absent_capabilities[].status', 'typed absence declaration status'),
  X('.pack.base_branch', 'git ref name, not a code symbol or path'),

  X('.pack.affected_communities[].label', 'community/cluster name, not a code symbol. "Drivers Github — Driver" must not satisfy the obligation "Driver".'),
  X('.pack.community_context[].label', 'community/cluster name, not a code symbol'),
  X('.pack.review_bundle.community_context[].label', 'community/cluster name, not a code symbol'),
  X('.pack.seed_nodes[].community_label', 'community/cluster name, not a code symbol'),
  X('.pack.top_paths_per_community[].label', 'community/cluster name, not a code symbol'),
  X('.workflow_centers[].reason', 'prose rationale'),
  X('.workflow_centers[].reasons[]', 'prose rationale'),
  X('.workflow_centers[].phases[]', 'pipeline-phase taxonomy value'),
  X('.implementation.workflow_centers[].reason', 'prose rationale'),
  X('.implementation.workflow_centers[].reasons[]', 'prose rationale'),
  X('.implementation.workflow_centers[].phases[]', 'pipeline-phase taxonomy value'),

  X('.claims[].evidence_class', 'evidence-class taxonomy value'),
  X('.claims[].text', 'prose restatement of node_labels, which are extracted directly'),
  X('.coverage.entries[].evidence_class', 'evidence-class taxonomy value'),
  X('.coverage.entries[].status', 'coverage status enum'),
  X('.coverage.missing_required[]', 'evidence-class taxonomy value'),
  X('.coverage.missing_semantic[]', 'semantic-category taxonomy value'),
  X('.coverage.required_evidence[]', 'evidence-class taxonomy value'),
  X('.coverage.semantic_entries[].category', 'semantic-category taxonomy value'),
  X('.coverage.semantic_entries[].label', 'semantic-category taxonomy value, not a code symbol'),
  X('.coverage.semantic_entries[].status', 'coverage status enum'),
  X('.coverage.semantic_optional[]', 'semantic-category taxonomy value'),
  X('.coverage.semantic_required[]', 'semantic-category taxonomy value'),

  X('.evidence.agent_directive', 'directive enum'),
  X('.evidence.answerability.answer_scope', 'scope enum'),
  X('.evidence.answerability.broad_search_fallback', 'fallback-policy enum'),
  X('.evidence.answerability.caveats[]', 'consumed as an absence-declaration channel, not as evidence for the target'),
  X('.evidence.answerability.missing_obligations[]', 'obligation identifiers; consumed as an unresolved-declaration channel'),
  X('.evidence.answerability.state', 'the published answerability state, read separately'),
  X('.evidence.answerability.verification_targets[].evidence_class', 'evidence-class taxonomy value'),
  X('.evidence.answerability.verification_targets[].handle_id', 'opaque expansion handle identifier'),
  X('.evidence.answerability.verification_targets[].reason', 'prose rationale'),
  X('.evidence.confidence_reasons[]', 'prose rationale'),
  X('.evidence.coverage', 'coverage status enum'),
  X('.evidence.coverage_detail.covered_obligations[]', 'obligation identifiers, not target evidence'),
  X('.evidence.coverage_detail.missing_obligations[]', 'obligation identifiers; consumed as an unresolved-declaration channel'),
  X('.evidence.coverage_detail.required_obligations[]', 'obligation identifiers, not target evidence'),
  X('.evidence.coverage_detail.status', 'coverage status enum'),
  X('.evidence.discovery_exclusions.policy', 'policy enum'),
  X('.evidence.evidence_strength.level', 'strength enum'),
  X('.evidence.evidence_strength.reasons[]', 'diagnostic reason code'),
  X('.evidence.indexing_completeness.state', 'completeness enum'),
  X('.evidence.missing_phases[]', 'pipeline-phase taxonomy value; consumed as an unresolved-declaration channel'),
  X('.evidence.pack_confidence', 'confidence enum'),
  X('.evidence.recovery.attempts[].status', 'recovery status enum'),
  X('.evidence.recovery.final_state', 'answerability enum from the recovery loop'),
  X('.evidence.recovery.initial_state', 'answerability enum from the recovery loop'),
  X('.evidence.recovery.status', 'recovery status enum'),

  X('.expandable[].evidence_class', 'evidence-class taxonomy value'),
  X('.expandable[].follow_up.evidence_class', 'evidence-class taxonomy value'),
  X('.expandable[].follow_up.kind', 'follow-up kind enum'),
  X('.expandable[].follow_up.task_kind', 'task-kind enum'),
  X('.expandable[].handle_id', 'opaque expansion handle identifier'),
  X('.expandable[].kind', 'expansion kind enum'),
  X('.expandable[].preview[].node_id', 'internal node identifier, not a source symbol'),

  X('.governance.directive.agent_directive', 'directive enum'),
  X('.governance.directive.answerability', 'the published answerability state, read separately'),
  X('.governance.directive.coverage', 'coverage status enum'),
  X('.governance.directive.evidence_strength', 'strength enum'),
  X('.governance.directive.missing_phases[]', 'pipeline-phase taxonomy value; consumed as an unresolved-declaration channel'),
  X('.governance.directive.pack_confidence', 'confidence enum'),
  X('.governance.follow_up.expandable_evidence_classes[]', 'evidence-class taxonomy value'),
  X('.governance.follow_up.expansion_task_kinds[]', 'task-kind enum'),
  X('.governance.graph_freshness.generated_at', 'tool timestamp'),
  X('.governance.graph_freshness.graph_modified_at', 'tool timestamp'),
  X('.governance.graph_freshness.graph_version', 'graph artifact version identifier'),
  X('.governance.graph_freshness.madar_version', 'Madar version string'),
  X('.governance.graph_freshness.recommendation', 'prose rationale'),
  X('.governance.graph_freshness.selected_context_status', 'freshness enum'),
  X('.governance.graph_freshness.status', 'freshness enum'),
  X('.governance.request.retrieval_strategy', 'retrieval strategy enum'),
  X('.governance.request.task', 'task-kind enum'),
  X('.governance.request.task_intent', 'task-intent enum'),
  X('.governance.surface', 'invocation surface enum'),

  X('.implementation.acceptance_criteria_summary[]', 'prose implementation guidance'),
  X('.implementation.cautions[]', 'prose implementation guidance'),
  X('.implementation.likely_edit_files[].phases[]', 'pipeline-phase taxonomy value'),
  X('.implementation.likely_edit_files[].reason', 'prose rationale'),
  X('.implementation.likely_edit_files[].why', 'prose rationale'),
  X('.implementation.likely_test_files[].phases[]', 'pipeline-phase taxonomy value'),
  X('.implementation.likely_test_files[].reason', 'prose rationale'),
  X('.implementation.likely_test_files[].why', 'prose rationale'),
  X('.implementation.retrieval_pipeline.phases[].phase', 'pipeline-phase taxonomy value'),
  X('.implementation.retrieval_pipeline.phases[].summary', 'prose rationale'),
  X('.implementation.risk_boundaries[].affected_communities[]', 'community/cluster name, not a code symbol'),
  X('.implementation.risk_boundaries[].reason', 'prose rationale'),
  X('.implementation.risk_boundaries[].severity', 'severity enum'),
  X('.implementation.summary', 'prose implementation guidance'),
  X('.implementation.validation_commands[]', 'shell command suggestion, not target evidence'),
  X('.implementation.contracts_and_public_surfaces[]', 'prose implementation guidance'),
  X('.implementation.existing_patterns[]', 'prose implementation guidance'),

  X('.likely_edit_files[].phases[]', 'pipeline-phase taxonomy value'),
  X('.likely_edit_files[].reason', 'prose rationale'),
  X('.likely_edit_files[].why', 'prose rationale'),
  X('.likely_test_files[].phases[]', 'pipeline-phase taxonomy value'),
  X('.likely_test_files[].reason', 'prose rationale'),
  X('.likely_test_files[].why', 'prose rationale'),
  X('.missing_context[]', 'evidence-class taxonomy value; consumed as an unresolved-declaration channel'),
  X('.missing_semantic[]', 'semantic-category taxonomy value; consumed as an unresolved-declaration channel'),
  X('.negative_guidance[]', 'prose guidance; consumed as an absence-declaration channel'),
  X('.public_contracts[]', 'prose guidance'),

  X('.pack.answer_contract.answer_focus', 'answer-contract enum'),
  X('.pack.answer_contract.confidence', 'confidence enum'),
  X('.pack.answer_contract.do_not_claim[]', 'prohibition identifiers; consumed as an absence-declaration channel'),
  X('.pack.answer_contract.entrypoint_scope', 'answer-contract enum'),
  X('.pack.answer_contract.missing_phases[]', 'pipeline-phase taxonomy value; consumed as an absence-declaration channel'),
  X('.pack.answer_contract.required_elements[]', 'answer-contract element identifiers'),
  X('.pack.answer_contract.uncertainty_notes[]', 'prose; consumed as an absence-declaration channel'),
  X('.pack.execution_slice.boundary_reason', 'diagnostic reason code'),
  X('.pack.execution_slice.confidence', 'confidence enum'),
  X('.pack.execution_slice.confidence_reasons[]', 'diagnostic reason code'),
  X('.pack.execution_slice.phase_coverage.expected[]', 'pipeline-phase taxonomy value'),
  X('.pack.execution_slice.phase_coverage.missing[]', 'pipeline-phase taxonomy value; consumed as an unresolved-declaration channel'),
  X('.pack.execution_slice.phase_coverage.observed[]', 'pipeline-phase taxonomy value'),
  X('.pack.execution_slice.primary_path.boundary_reason', 'diagnostic reason code'),
  X('.pack.execution_slice.status', 'slice status enum'),
  X('.pack.direct_dependents[].relation', 'relation-kind taxonomy value'),
  X('.pack.transitive_dependents[].relation', 'relation-kind taxonomy value'),
  X('.pack.relationships[].relation', 'relation-kind taxonomy value'),
  X('.pack.relationships[].from_id', 'internal node identifier, not a source symbol'),
  X('.pack.relationships[].to_id', 'internal node identifier, not a source symbol'),
  X('.pack.review_bundle.relationships[].relation', 'relation-kind taxonomy value'),
  X('.pack.review_bundle.nodes[].node_id', 'internal node identifier, not a source symbol'),
  X('.pack.review_bundle.nodes[].node_kind', 'node-kind taxonomy value'),
  X('.pack.review_bundle.nodes[].relevance_band', 'relevance band enum'),
  X('.pack.review_bundle.nodes[].representation_reason', 'prose rationale'),
  X('.pack.review_bundle.nodes[].representation_type', 'representation enum'),
  X('.pack.review_bundle.shared_file_type', 'file-type enum'),
  X('.pack.review_context.hotspots[].type', 'hotspot-kind enum'),
  X('.pack.review_context.hotspots[].why', 'prose rationale'),
  X('.pack.risk_summary.top_risks[].reason', 'prose rationale'),
  X('.pack.risk_summary.top_risks[].severity', 'severity enum'),
  X('.pack.matched_nodes[].node_id', 'internal node identifier, not a source symbol'),
  X('.pack.matched_nodes[].node_kind', 'node-kind taxonomy value'),
  X('.pack.matched_nodes[].relevance_band', 'relevance band enum'),
  X('.pack.matched_nodes[].representation_reason', 'prose rationale'),
  X('.pack.matched_nodes[].representation_type', 'representation enum'),
  X('.pack.matched_nodes[].snippet_scope', 'snippet scope enum'),
  X('.pack.matched_nodes[].source_domain', 'source-domain enum'),
  X('.pack.seed_nodes[].match_kind', 'match-kind enum'),
  X('.pack.seed_nodes[].node_id', 'internal node identifier, not a source symbol'),
  X('.pack.seed_nodes[].node_kind', 'node-kind taxonomy value'),
  X('.pack.seed_nodes[].source_location', 'line marker such as "L31", not a path'),
  X('.pack.slice.anchors[].node_id', 'internal node identifier, not a source symbol'),
  X('.pack.slice.anchors[].reason', 'prose rationale'),
  X('.pack.slice.directions[]', 'traversal-direction enum'),
  X('.pack.slice.mode', 'slice mode enum'),
  X('.pack.slice.selected_paths[].direction', 'traversal-direction enum'),
  X('.pack.slice.selected_paths[].from_id', 'internal node identifier, not a source symbol'),
  X('.pack.slice.selected_paths[].relation', 'relation-kind taxonomy value'),
  X('.pack.slice.selected_paths[].to_id', 'internal node identifier, not a source symbol'),
  X('.pack.retrieval_gate.intent', 'retrieval-gate enum'),
  X('.pack.retrieval_gate.reason', 'prose rationale'),
  X('.pack.retrieval_gate.signals.generation_intent', 'retrieval-gate enum'),
  X('.pack.retrieval_gate.signals.target_domain_hint', 'retrieval-gate enum'),
  X('.pack.retrieval_plan.attempts[].expansion_terms[]', 'query expansion terms, derived from the prompt not the graph'),
  X('.pack.retrieval_plan.attempts[].fallback', 'fallback enum'),
  X('.pack.retrieval_plan.attempts[].reasons[]', 'diagnostic reason code'),
  X('.pack.retrieval_plan.attempts[].status', 'retrieval status enum'),
  X('.pack.retrieval_plan.attempts[].vocabulary_sources[]', 'vocabulary source enum'),
  X('.pack.retrieval_plan.attempts[].promoted_communities[]', 'community/cluster name, not a code symbol'),
  X('.pack.retrieval_plan.reasons[]', 'diagnostic reason code'),
  X('.pack.retrieval_plan.selected_fallback', 'fallback enum'),
  X('.pack.retrieval_plan.status', 'retrieval status enum'),
  X('.pack.retrieval_strategy', 'retrieval strategy enum'),
  X('.pack.recovery.attempts[].status', 'recovery status enum'),
  X('.pack.recovery.final_state', 'answerability enum from the recovery loop'),
  X('.pack.recovery.initial_state', 'answerability enum from the recovery loop'),
  X('.pack.recovery.status', 'recovery status enum'),
  X('.pack.shared_file_type', 'file-type enum'),
  X('.pack.target_file_type', 'file-type enum'),
  X('.pack.uncovered_hotspots[]', 'hotspot identifiers reported as NOT covered; an uncovered hotspot is not evidence the pack surfaced'),
  X('.pack.uncovered_hotspot_severities[]', 'severity enum'),

  X('.plan.evidence.preferred[]', 'evidence-class taxonomy value'),
  X('.plan.evidence.recipe_id', 'planner recipe identifier'),
  X('.plan.evidence.required[]', 'evidence-class taxonomy value'),
  X('.plan.evidence.semantic_optional[]', 'semantic-category taxonomy value'),
  X('.plan.evidence.semantic_required[]', 'semantic-category taxonomy value'),
  X('.plan.scope.changed_paths[]', 'planner scope input, not retrieved evidence'),
  X('.plan.scope.focus_paths[]', 'planner scope input, not retrieved evidence'),
  X('.plan.scope.seed_mode', 'planner scope enum'),
  X('.plan.steps[].evidence[]', 'evidence-class taxonomy value'),
  X('.plan.steps[].id', 'planner step identifier'),
  X('.plan.steps[].kind', 'planner step kind enum'),
  X('.plan.steps[].scope_mode', 'planner scope enum'),
  X('.plan.steps[].scope_paths[]', 'planner scope input, not retrieved evidence'),
  X('.plan.steps[].title', 'prose planner step title'),
  X('.plan.task_kind', 'task-kind enum'),

  X('.recommended_first_read[].reason', 'prose rationale'),
  X('.retrieval_gate.intent', 'retrieval-gate enum'),
  X('.retrieval_gate.reason', 'prose rationale'),
  X('.retrieval_gate.signals.generation_intent', 'retrieval-gate enum'),
  X('.retrieval_gate.signals.target_domain_hint', 'retrieval-gate enum'),
  X('.retrieval_pipeline.phases[].phase', 'pipeline-phase taxonomy value'),
  X('.retrieval_pipeline.phases[].summary', 'prose rationale'),
  X('.risk_boundaries[].affected_communities[]', 'community/cluster name, not a code symbol'),
  X('.risk_boundaries[].reason', 'prose rationale'),
  X('.risk_boundaries[].severity', 'severity enum'),
  X('.task', 'task-kind enum'),
  X('.task_intent', 'task-intent enum'),
  X('.validation_commands[]', 'shell command suggestion, not target evidence'),
  X('.why_explanation[]', 'prose rationale. Paths named here are already carried by the structured channels they explain; mining prose would count text, not evidence.'),
]

const BY_CHANNEL = new Map(EVIDENCE_CHANNELS.map((entry) => [entry.channel, entry]))

if (BY_CHANNEL.size !== EVIDENCE_CHANNELS.length) {
  const seen = new Set()
  const duplicates = EVIDENCE_CHANNELS.map((entry) => entry.channel)
    .filter((channel) => (seen.has(channel) ? true : (seen.add(channel), false)))
  throw new Error(`duplicate channel classification: ${[...new Set(duplicates)].join(', ')}`)
}

export function channelFor(channel) {
  return BY_CHANNEL.get(channel) ?? null
}

/** Collapse array indices so `.a[3].b` and `.a[7].b` are one channel. */
export function genericChannel(schemaPath) {
  return schemaPath.replace(/\[\d+\]/g, '[]')
}

/**
 * Walk every string leaf of an artifact, yielding
 * `{ schemaPath, channel, value }`. Nothing is filtered here: the caller
 * decides, and a channel that reaches no decision is a closure failure.
 */
export function* stringLeaves(node, schemaPath = '', parent = null) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) yield* stringLeaves(node[index], `${schemaPath}[${index}]`, parent)
    return
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) yield* stringLeaves(value, `${schemaPath}.${key}`, node)
    return
  }
  if (typeof node !== 'string') return
  yield { schemaPath, channel: genericChannel(schemaPath), value: node, parent }
}
