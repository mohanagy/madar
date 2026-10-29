import type { SourceModuleConfigurationSnapshot } from './source-modules.js'

/** Request-local observations only. Missing sidecars (including serialized cache hits)
 * are unknown; never reconstruct selection roles from public rank or wire data. */
export const sourceSelectionProvenanceKey = Symbol('sourceSelectionProvenance')
export type SourceScanStatus = 'not_started' | 'complete' | 'incomplete'
export type SourceAdmissionRole = 'incoming' | 'outgoing' | 'data_reference'
export interface SourceSeedOrigins {
  requested_member_ids: string[]
  explicit_symbol_candidate_ids: string[]
  helper_request_ids: string[]
  named_file_member_ids: string[]
  anchor_ids: string[]
  heuristic_anchor_ids: string[]
}
export interface SourceSelectionProvenance {
  version: 1
  /** Completeness below describes existing supported scans inside this program,
   * never all syntax, workspace dependencies, or runtime behavior. */
  scope: 'bounded_supported_static_source'
  root_path?: string
  seed_ids: string[]
  /** Undefined means the caller did not supply origin information. Membership
   * can overlap; an explicit candidate need not have unique request ownership. */
  seed_origins?: SourceSeedOrigins
  policy: { include_callers: boolean; caller_priority: boolean; inspection_only: boolean }
  /** First successful dependency-stage admission only; seeds are never re-admitted. */
  admissions: Array<{ node_id: string; role: SourceAdmissionRole; depth: number }>
  /** Roles encountered at inspected selection frontiers, including already-selected
   * and attempted-but-unadmitted IDs. These are not first-admission events. */
  observed_roles: Array<{ node_id: string; roles: SourceAdmissionRole[] }>
  /** Dependency-stage membership, before final pack selection or budgeting. */
  selected_ids: string[]
  addition_limit_hit: boolean
  /** Traversal completion only; owner ambiguities and unresolved bindings remain
   * separately recorded even when the corresponding traversal completed. */
  scans: Record<'source_loading' | 'program' | 'identity' | 'calls' | 'data_references' | 'mutation' | 'write_origins', SourceScanStatus>
  limitations: string[]
  sources: Array<{ source_file: string; source_sha256: string; in_program: boolean; canonical_file?: string }>
  /** Observed config fingerprints, including missing files, not a fresh-proof. */
  configuration?: SourceModuleConfigurationSnapshot
  owners: Array<{ node_id: string; source_file: string; indexed_range: { start: number; end: number };
    status: 'unique' | 'ambiguous' | 'unmatched' | 'incomplete'; declaration_offsets?: { start: number; end: number } }>
  resolved_pairs: Array<{ from_id: string; to_id: string; relation: 'calls' | 'depends_on';
    kind: 'call' | 'function_value_argument' | 'data_reference' }>
  /** Individually observed positive sites, never a complete occurrence set or runtime proof. */
  observed_sites?: Array<{ from_id: string; to_id: string; kind: 'call' | 'function_value_argument' | 'data_reference';
    source_file: string; source_sha256: string; start_offset: number; end_offset: number }>
  unresolved: Array<{ from_id: string; source_file: string; line_number: number; callee: string;
    relation: 'calls' | 'depends_on'; reason: string }>
  unattributed_calls: number
  forward: { known_reachable_ids: string[]; unresolved_from_reachable_ids: string[];
    /** Even a complete supported scan cannot prove absence of dynamic/unsupported
     * dependencies. Admission through an incoming edge does not mean optional. */
    exclusion_proof: 'not_provided' }
}

/** Positive reachability only, bounded by pairs already inspected; cycles are safe. */
export function recordKnownForwardReachability(value: SourceSelectionProvenance): void {
  const outgoing = new Map<string, string[]>()
  for (const pair of value.resolved_pairs) {
    const targets = outgoing.get(pair.from_id) ?? []
    targets.push(pair.to_id); outgoing.set(pair.from_id, targets)
  }
  const reachable = new Set(value.seed_ids), queue = [...reachable]
  for (let index = 0; index < queue.length; index++) for (const target of outgoing.get(queue[index]!) ?? []) {
    if (!reachable.has(target)) { reachable.add(target); queue.push(target) }
  }
  value.forward = { known_reachable_ids: [...reachable],
    unresolved_from_reachable_ids: [...new Set(value.unresolved.filter(entry => reachable.has(entry.from_id)).map(entry => entry.from_id))],
    exclusion_proof: 'not_provided' }
}
