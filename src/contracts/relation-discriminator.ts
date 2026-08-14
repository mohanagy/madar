import type { CanonicalJson } from './canonical-json.js'

export const RELATION_DISCRIMINATOR_REGISTRY_ID = 'madar.relation-discriminator-registry/1' as const

export const REGISTERED_RELATIONS = Object.freeze([
  'cites',
  'contains',
  'declares',
  'declares_controller',
  'defines_action',
  'defines_selector',
  'inherits',
  'loads_route',
  'method',
  'provides',
  'rationale_for',
  'references',
  'renders',
  'shared_across_repos',
  'submits_route',
  'calls',
  'depends_on',
  'enqueues_job',
  'handles_route',
  'imports',
  'imports_from',
  'injects',
  'middleware',
  'mounts_router',
  'registered_in_store',
  'registers_route',
  'updates_slice',
  'uses',
  'uses_guard',
  'uses_interceptor',
  'uses_pipe',
] as const)

export type RegisteredRelation = (typeof REGISTERED_RELATIONS)[number]
export type SemanticDiscriminatorCompleteness = 'endpoint_only' | 'partial' | 'full'

export interface RelationDiscriminatorPolicy {
  readonly relation: RegisteredRelation
  readonly policyVersion: 1
  readonly completeness: SemanticDiscriminatorCompleteness
  readonly canonicalValue: CanonicalJson
  readonly reasons: readonly string[]
}

export interface SemanticDiscriminator {
  readonly registryId: typeof RELATION_DISCRIMINATOR_REGISTRY_ID
  readonly policyVersion: number
  readonly completeness: SemanticDiscriminatorCompleteness
  readonly canonicalValue: CanonicalJson
  readonly reasons: readonly string[]
}

function endpointOnly(relation: RegisteredRelation): RelationDiscriminatorPolicy {
  return Object.freeze({
    relation,
    policyVersion: 1 as const,
    completeness: 'endpoint_only' as const,
    canonicalValue: null,
    reasons: Object.freeze([]),
  })
}

function partial(relation: RegisteredRelation, reasons: readonly string[]): RelationDiscriminatorPolicy {
  return Object.freeze({
    relation,
    policyVersion: 1 as const,
    completeness: 'partial' as const,
    canonicalValue: null,
    reasons: Object.freeze([...reasons]),
  })
}

/**
 * Exhaustive Stage 1 registry. Partial entries name the behavior data current
 * producers do not yet supply; no arbitrary edge metadata is hashed.
 */
export const RELATION_DISCRIMINATOR_REGISTRY_V1: Readonly<Record<RegisteredRelation, RelationDiscriminatorPolicy>> = Object.freeze({
  cites: endpointOnly('cites'),
  contains: endpointOnly('contains'),
  declares: endpointOnly('declares'),
  declares_controller: endpointOnly('declares_controller'),
  defines_action: endpointOnly('defines_action'),
  defines_selector: endpointOnly('defines_selector'),
  inherits: endpointOnly('inherits'),
  loads_route: endpointOnly('loads_route'),
  method: endpointOnly('method'),
  provides: endpointOnly('provides'),
  rationale_for: endpointOnly('rationale_for'),
  references: endpointOnly('references'),
  renders: endpointOnly('renders'),
  shared_across_repos: endpointOnly('shared_across_repos'),
  submits_route: endpointOnly('submits_route'),

  calls: partial('calls', [
    'dispatch_kind_missing',
    'invocation_kind_missing',
    'optionality_missing',
    'overload_identity_missing',
    'resolution_state_missing',
  ]),
  depends_on: partial('depends_on', [
    'dependency_kind_missing',
    'resolution_state_missing',
  ]),
  enqueues_job: partial('enqueues_job', [
    'job_identity_missing',
    'channel_name_missing',
    'routing_key_missing',
  ]),
  handles_route: partial('handles_route', [
    'http_method_missing',
    'normalized_route_path_missing',
    'registration_origin_missing',
  ]),
  imports: partial('imports', [
    'import_binding_kind_missing',
    'imported_binding_missing',
    'import_phase_missing',
    'import_form_missing',
    'module_specifier_missing',
    'resolution_state_missing',
  ]),
  imports_from: partial('imports_from', [
    'import_binding_kind_missing',
    'imported_binding_missing',
    'import_phase_missing',
    'import_form_missing',
    'module_specifier_missing',
    'resolution_state_missing',
  ]),
  injects: partial('injects', [
    'injection_token_missing',
    'qualifier_missing',
    'scope_missing',
    'binding_kind_missing',
    'resolved_implementation_missing',
    'resolution_state_missing',
  ]),
  middleware: partial('middleware', [
    'normalized_route_path_missing',
    'router_scope_missing',
    'middleware_order_missing',
    'registration_origin_missing',
  ]),
  mounts_router: partial('mounts_router', [
    'normalized_mount_path_missing',
    'router_scope_missing',
    'mount_order_missing',
    'registration_origin_missing',
  ]),
  registered_in_store: partial('registered_in_store', [
    'registration_kind_missing',
    'store_slot_missing',
    'resolution_state_missing',
  ]),
  registers_route: partial('registers_route', [
    'http_method_missing',
    'normalized_route_path_missing',
    'registration_type_missing',
    'router_scope_missing',
    'route_order_missing',
    'registration_origin_missing',
  ]),
  updates_slice: partial('updates_slice', [
    'action_identity_missing',
    'update_kind_missing',
  ]),
  uses: partial('uses', [
    'usage_kind_missing',
    'resolution_state_missing',
  ]),
  uses_guard: partial('uses_guard', [
    'guard_scope_missing',
    'guard_order_missing',
    'registration_origin_missing',
  ]),
  uses_interceptor: partial('uses_interceptor', [
    'interceptor_scope_missing',
    'interceptor_order_missing',
    'registration_origin_missing',
  ]),
  uses_pipe: partial('uses_pipe', [
    'pipe_scope_missing',
    'pipe_order_missing',
    'registration_origin_missing',
  ]),
})

const REGISTERED_RELATION_SET = new Set<string>(REGISTERED_RELATIONS)

export function isRegisteredRelation(relation: string): relation is RegisteredRelation {
  return REGISTERED_RELATION_SET.has(relation)
}

export type RegisteredRelationDiscriminatorResolution = Readonly<{
  status: 'registered'
  storageDisposition: 'retain' | 'retain_degraded'
  factIdentityEligible: true
  discriminator: SemanticDiscriminator
}>

export type UnregisteredRelationDiscriminatorResolution = Readonly<{
  status: 'unregistered'
  storageDisposition: 'unresolved_degraded'
  factIdentityEligible: false
  relation: string
  reasons: readonly ['relation_not_registered']
}>

export type RelationDiscriminatorResolution =
  | RegisteredRelationDiscriminatorResolution
  | UnregisteredRelationDiscriminatorResolution

/**
 * Resolves storage-boundary handling explicitly. Unknown relations are not
 * facts and are not topology-eligible in this slice; later accounting can
 * persist the returned degraded reason without inventing endpoint-only identity.
 */
export function resolveRelationDiscriminator(relation: string): RelationDiscriminatorResolution {
  if (!isRegisteredRelation(relation)) {
    return Object.freeze({
      status: 'unregistered' as const,
      storageDisposition: 'unresolved_degraded' as const,
      factIdentityEligible: false as const,
      relation,
      reasons: Object.freeze(['relation_not_registered'] as const),
    })
  }

  const policy = RELATION_DISCRIMINATOR_REGISTRY_V1[relation]
  const discriminator: SemanticDiscriminator = Object.freeze({
    registryId: RELATION_DISCRIMINATOR_REGISTRY_ID,
    policyVersion: policy.policyVersion,
    completeness: policy.completeness,
    canonicalValue: policy.canonicalValue,
    reasons: policy.reasons,
  })
  return Object.freeze({
    status: 'registered' as const,
    storageDisposition: policy.completeness === 'partial' ? 'retain_degraded' as const : 'retain' as const,
    factIdentityEligible: true as const,
    discriminator,
  })
}
