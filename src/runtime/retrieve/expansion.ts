import type { RetrievalLevel } from '../../contracts/retrieval-gate.js'

const PRIMARY_RELATIONS = new Set([
  'calls',
  'imports_from',
  'contains',
  'method',
  'route_handler',
  'controller_route',
])

const BEHAVIOR_RELATIONS = new Set([
  ...PRIMARY_RELATIONS,
  'covered_by',
  'uses_config',
  'reads_env',
  'module_provides',
  'injects',
  'guarded_by',
  'uses_guard',
  'uses_pipe',
  'uses_interceptor',
])

const IMPACT_RELATIONS = new Set([
  ...BEHAVIOR_RELATIONS,
  'depends_on',
  'uses',
  'references',
  'exports',
  'registered_in_store',
  'updates_slice',
  'loads_route',
  'submits_route',
])

export interface RetrievalExpansionPolicy {
  level: RetrievalLevel
  seed_limit: number
  predecessor_mode: 'none' | 'same-community' | 'all'
  hop1_relations: ReadonlySet<string> | null
  hop2_relations: ReadonlySet<string> | null
  max_second_hop_adds: number
  include_peripheral: boolean
}

export function expansionPolicyForLevel(level: RetrievalLevel, budget: number): RetrievalExpansionPolicy {
  switch (level) {
    case 0:
      return {
        level,
        seed_limit: 0,
        predecessor_mode: 'none',
        hop1_relations: null,
        hop2_relations: null,
        max_second_hop_adds: 0,
        include_peripheral: false,
      }
    case 1:
      return {
        level,
        seed_limit: 2,
        predecessor_mode: 'none',
        hop1_relations: null,
        hop2_relations: null,
        max_second_hop_adds: 0,
        include_peripheral: false,
      }
    case 2:
      return {
        level,
        seed_limit: 4,
        predecessor_mode: 'none',
        hop1_relations: PRIMARY_RELATIONS,
        hop2_relations: null,
        max_second_hop_adds: 0,
        include_peripheral: false,
      }
    case 3:
      return {
        level,
        seed_limit: 5,
        predecessor_mode: 'same-community',
        hop1_relations: BEHAVIOR_RELATIONS,
        hop2_relations: budget >= 1500 ? BEHAVIOR_RELATIONS : null,
        max_second_hop_adds: budget >= 5000 ? 3 : 2,
        include_peripheral: false,
      }
    case 4:
      return {
        level,
        seed_limit: 6,
        predecessor_mode: 'all',
        hop1_relations: IMPACT_RELATIONS,
        hop2_relations: budget >= 1500 ? IMPACT_RELATIONS : null,
        max_second_hop_adds: budget >= 5000 ? 6 : 4,
        include_peripheral: true,
      }
    case 5:
    default:
      return {
        level,
        seed_limit: 8,
        predecessor_mode: 'all',
        hop1_relations: IMPACT_RELATIONS,
        hop2_relations: IMPACT_RELATIONS,
        max_second_hop_adds: budget >= 5000 ? 8 : 6,
        include_peripheral: true,
      }
  }
}

export function relationAllowedForPolicy(
  relations: ReadonlySet<string> | null,
  relation: string,
): boolean {
  return relations !== null && relations.has(relation)
}

export function predecessorAllowedForPolicy(
  mode: RetrievalExpansionPolicy['predecessor_mode'],
  seedCommunity: number | null | undefined,
  neighborCommunity: number | null | undefined,
): boolean {
  if (mode === 'none') {
    return false
  }
  if (mode === 'all') {
    return true
  }

  return seedCommunity !== null
    && seedCommunity !== undefined
    && neighborCommunity !== null
    && neighborCommunity !== undefined
    && seedCommunity === neighborCommunity
}

export function relationIsPrimaryForPolicy(level: RetrievalLevel, relation: string): boolean {
  return PRIMARY_RELATIONS.has(relation)
    || (level >= 3 && BEHAVIOR_RELATIONS.has(relation))
    || (level >= 4 && IMPACT_RELATIONS.has(relation))
}
