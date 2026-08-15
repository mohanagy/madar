import { normalizeCanonicalJson, serializeCanonicalJson, type CanonicalJson } from './canonical-json.js'

export const RELATION_DISCRIMINATOR_REGISTRY_ID = 'madar.relation-discriminator-registry/1' as const
export const LEGACY_RELATION_DISCRIMINATOR_POLICY_VERSION = 0 as const
export const LEGACY_PARALLEL_FACTS_UNRECOVERABLE = 'legacy_parallel_facts_unrecoverable' as const

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
  'extends',
  'handles_route',
  'implements',
  'imports',
  'imports_from',
  'injects',
  'middleware',
  'mounts_router',
  'registered_in_store',
  'registers_controller',
  'registers_route',
  'updates_slice',
  'uses',
  'uses_guard',
  'uses_interceptor',
  'uses_pipe',

  // Producer relations recovered by the authoritative inventory. Every one is
  // emitted by an in-repository producer; eight reach their `kind` slot through
  // an argument, a mapping table or a type union rather than a literal, which is
  // why two grep-based enumerations and one AST pass all missed them. They are
  // now derived from SPI_EDGE_KINDS, which is the declaration itself.
  'changed_in',
  'controller_route',
  'covered_by',
  'exports',
  'guards',
  'intercepts',
  'module_exports',
  'module_imports',
  'module_provides',
  'param_type',
  'pipes',
  'related_to',
  'return_type',
  'route_handler',
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
  /** Present only on facts converted independently from a v1 link. */
  readonly legacy?: true
}

export function createLegacyRelationDiscriminator(
  linkFingerprint: string,
  duplicateOrdinal: number,
): SemanticDiscriminator {
  if (!/^[a-f0-9]{64}$/.test(linkFingerprint)) {
    throw new RelationDiscriminatorInvariantError('legacy link fingerprint must be full lowercase SHA-256 hex')
  }
  if (!Number.isSafeInteger(duplicateOrdinal) || duplicateOrdinal < 0) {
    throw new RelationDiscriminatorInvariantError('legacy duplicate ordinal must be a non-negative safe integer')
  }
  return Object.freeze({
    registryId: RELATION_DISCRIMINATOR_REGISTRY_ID,
    policyVersion: LEGACY_RELATION_DISCRIMINATOR_POLICY_VERSION,
    completeness: 'partial' as const,
    canonicalValue: Object.freeze({
      legacy_link_fingerprint: linkFingerprint,
      legacy_duplicate_ordinal: duplicateOrdinal,
    }),
    reasons: Object.freeze([LEGACY_PARALLEL_FACTS_UNRECOVERABLE]),
    legacy: true as const,
  })
}

export class RelationDiscriminatorInvariantError extends Error {
  constructor(message: string) {
    super(`Relation discriminator invariant failed: ${message}`)
    this.name = 'RelationDiscriminatorInvariantError'
  }
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
  extends: endpointOnly('extends'),
  implements: endpointOnly('implements'),
  inherits: endpointOnly('inherits'),
  loads_route: endpointOnly('loads_route'),
  method: endpointOnly('method'),
  provides: endpointOnly('provides'),
  rationale_for: endpointOnly('rationale_for'),
  references: endpointOnly('references'),
  registers_controller: endpointOnly('registers_controller'),
  renders: endpointOnly('renders'),
  shared_across_repos: endpointOnly('shared_across_repos'),
  submits_route: endpointOnly('submits_route'),
  // Structural registration and coverage links: the pair is the whole fact.
  covered_by: endpointOnly('covered_by'),
  guards: endpointOnly('guards'),
  intercepts: endpointOnly('intercepts'),
  pipes: endpointOnly('pipes'),
  module_exports: endpointOnly('module_exports'),
  module_imports: endpointOnly('module_imports'),
  module_provides: endpointOnly('module_provides'),
  // A function has one return type per referenced type, so the pair is unique.
  return_type: endpointOnly('return_type'),
  /**
   * Generic structural fallback. Every current in-repository use is a
   * presentation default (`edge.label || 'related_to'` in the interactive
   * payload, `attributes.relation ?? 'related_to'` in community details) that
   * carries no behavior-defining data, so endpoint-only is the accurate
   * policy rather than a partial with invented missing fields. It is
   * registered because it also arrives as compatibility input.
   */
  related_to: endpointOnly('related_to'),

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
  // Route registration edges carry the decorator site but not the route
  // behavior; HTTP method and normalized path live on the symbol's framework
  // metadata, not on the edge.
  controller_route: partial('controller_route', [
    'http_method_missing',
    'normalized_route_path_missing',
    'registration_origin_missing',
  ]),
  route_handler: partial('route_handler', [
    'http_method_missing',
    'normalized_route_path_missing',
    'registration_origin_missing',
  ]),
  // File-layer export self-edge. Symbol-level export identity is explicitly
  // deferred by the producer, so the binding is genuinely absent.
  exports: partial('exports', [
    'exported_binding_missing',
    'export_form_missing',
    'module_specifier_missing',
    'resolution_state_missing',
  ]),
  // Two parameters of one function can reference the same type; without the
  // parameter position those edges are not distinguishable.
  param_type: partial('param_type', [
    'parameter_position_missing',
    'type_reference_form_missing',
  ]),
  // Diff-overlay edges name no revision, so "changed in A" and "changed in B"
  // are the same pair.
  changed_in: partial('changed_in', [
    'revision_identity_missing',
    'change_kind_missing',
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
export function resolveRelationDiscriminator(
  relation: string,
  canonicalValue?: CanonicalJson,
): RelationDiscriminatorResolution {
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
  const normalizedValue = normalizeCanonicalJson(
    canonicalValue ?? policy.canonicalValue,
    { arraySemantics: 'ordered' },
  )
  if (
    policy.completeness === 'endpoint_only'
    && serializeCanonicalJson(normalizedValue, { arraySemantics: 'ordered' })
      !== serializeCanonicalJson(policy.canonicalValue, { arraySemantics: 'ordered' })
  ) {
    throw new RelationDiscriminatorInvariantError(
      `endpoint-only relation ${relation} cannot carry a discriminator value`,
    )
  }
  const discriminator: SemanticDiscriminator = Object.freeze({
    registryId: RELATION_DISCRIMINATOR_REGISTRY_ID,
    policyVersion: policy.policyVersion,
    completeness: policy.completeness,
    canonicalValue: normalizedValue,
    reasons: policy.reasons,
  })
  return Object.freeze({
    status: 'registered' as const,
    storageDisposition: policy.completeness === 'partial' ? 'retain_degraded' as const : 'retain' as const,
    factIdentityEligible: true as const,
    discriminator,
  })
}
