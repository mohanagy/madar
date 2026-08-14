export const ENDPOINT_IDENTITY_STATUSES = [
  'stable',
  'context_bound',
  'unknown',
  'legacy',
] as const

export type EndpointIdentityStatus = (typeof ENDPOINT_IDENTITY_STATUSES)[number]

export const ENDPOINT_IDENTITY_REASONS = [
  'source_location_derived',
  'absolute_workspace_path_derived',
  'source_ordinal_derived',
  'collision_suffix_derived',
  'adapter_local_synthetic_identity',
  'identity_policy_not_declared',
  'identity_policy_not_audited',
  'legacy_identity_policy',
] as const

export type EndpointIdentityReason = (typeof ENDPOINT_IDENTITY_REASONS)[number]

export type EndpointContextDependencyReason = Extract<EndpointIdentityReason,
  | 'source_location_derived'
  | 'absolute_workspace_path_derived'
  | 'source_ordinal_derived'
  | 'collision_suffix_derived'
  | 'adapter_local_synthetic_identity'
>

export interface EndpointIdentityEndpointQualification {
  readonly status: EndpointIdentityStatus
  readonly reasons: readonly EndpointIdentityReason[]
}

export interface EndpointIdentityQualification {
  readonly source: EndpointIdentityEndpointQualification
  readonly target: EndpointIdentityEndpointQualification
}

export class EndpointIdentityInvariantError extends Error {
  constructor(message: string) {
    super(`Endpoint identity invariant failed: ${message}`)
    this.name = 'EndpointIdentityInvariantError'
  }
}

const STATUS_SET = new Set<string>(ENDPOINT_IDENTITY_STATUSES)
const REASON_SET = new Set<string>(ENDPOINT_IDENTITY_REASONS)
const CONTEXT_REASONS = new Set<EndpointIdentityReason>([
  'source_location_derived',
  'absolute_workspace_path_derived',
  'source_ordinal_derived',
  'collision_suffix_derived',
  'adapter_local_synthetic_identity',
])
const UNKNOWN_REASONS = new Set<EndpointIdentityReason>([
  'identity_policy_not_declared',
  'identity_policy_not_audited',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertEndpointStatusConsistency(
  endpoint: 'source' | 'target',
  status: EndpointIdentityStatus,
  reasons: readonly EndpointIdentityReason[],
): void {
  const invalid = (message: string): never => {
    throw new EndpointIdentityInvariantError(`${endpoint} ${message}`)
  }

  if (status === 'stable') {
    if (reasons.length !== 0) invalid('is stable but carries a degradation reason')
    return
  }
  if (status === 'context_bound') {
    if (reasons.length === 0) invalid('is context_bound but has no context-dependency reason')
    if (reasons.some((reason) => !CONTEXT_REASONS.has(reason))) {
      invalid('is context_bound but carries a non-context reason')
    }
    return
  }
  if (status === 'unknown') {
    if (reasons.length === 0 || reasons.some((reason) => !UNKNOWN_REASONS.has(reason))) {
      invalid('is unknown but does not carry only an unknown-policy reason')
    }
    return
  }
  if (reasons.length !== 1 || reasons[0] !== 'legacy_identity_policy') {
    invalid('is legacy but does not carry exactly legacy_identity_policy')
  }
}

function validateEndpoint(
  value: unknown,
  endpoint: 'source' | 'target',
): EndpointIdentityEndpointQualification {
  if (!isRecord(value)) {
    throw new EndpointIdentityInvariantError(`${endpoint} qualification must be an object`)
  }
  if (typeof value.status !== 'string' || !STATUS_SET.has(value.status)) {
    throw new EndpointIdentityInvariantError(`${endpoint} has an invalid status`)
  }
  if (!Array.isArray(value.reasons)) {
    throw new EndpointIdentityInvariantError(`${endpoint} reasons must be an array`)
  }

  const reasons: EndpointIdentityReason[] = []
  for (const reason of value.reasons) {
    if (typeof reason !== 'string' || !REASON_SET.has(reason)) {
      throw new EndpointIdentityInvariantError(`${endpoint} has an invalid reason`)
    }
    reasons.push(reason as EndpointIdentityReason)
  }

  const status = value.status as EndpointIdentityStatus
  assertEndpointStatusConsistency(endpoint, status, reasons)
  return Object.freeze({ status, reasons: Object.freeze(reasons) })
}

/** Validates both endpoints and rejects every impossible status/reason combination. */
export function validateEndpointIdentityQualification(value: unknown): EndpointIdentityQualification {
  if (!isRecord(value)) {
    throw new EndpointIdentityInvariantError('Endpoint identity qualification must be an object')
  }
  return Object.freeze({
    source: validateEndpoint(value.source, 'source'),
    target: validateEndpoint(value.target, 'target'),
  })
}

function undeclaredEndpoint(): EndpointIdentityEndpointQualification {
  return Object.freeze({
    status: 'unknown',
    reasons: Object.freeze(['identity_policy_not_declared'] as const),
  })
}

/**
 * Compatibility normalization is deliberately property-presence based. Only a
 * genuinely omitted member receives the explicit unknown qualification; a
 * present malformed value is sent through strict invariant validation.
 */
export function normalizeEndpointIdentityQualification(owner: unknown): EndpointIdentityQualification {
  if (!isRecord(owner)) {
    throw new EndpointIdentityInvariantError('qualification owner must be an object')
  }
  if (!Object.prototype.hasOwnProperty.call(owner, 'endpointIdentity')) {
    return Object.freeze({ source: undeclaredEndpoint(), target: undeclaredEndpoint() })
  }
  return validateEndpointIdentityQualification(owner.endpointIdentity)
}

export function isEndpointIdentityDegraded(qualification: EndpointIdentityQualification): boolean {
  return qualification.source.status !== 'stable' || qualification.target.status !== 'stable'
}

export const ENDPOINT_IDENTITY_POLICY_VERSION = 'madar.endpoint-identity-classification-policy/1' as const

export interface EndpointConstructorIdentityInventoryEntry {
  readonly id: string
  readonly sites: readonly [string]
  readonly status: 'context_bound'
  readonly reason: EndpointContextDependencyReason
}

function inventoryEntry(
  id: string,
  site: string,
  reason: EndpointContextDependencyReason,
): EndpointConstructorIdentityInventoryEntry {
  return Object.freeze({
    id,
    sites: Object.freeze([site]) as readonly [string],
    status: 'context_bound' as const,
    reason,
  })
}

/**
 * Stage 0's audited constructor inventory. Classification consults only this
 * data; it never infers stability from missing source-location attributes.
 */
export const ENDPOINT_CONSTRUCTOR_IDENTITY_INVENTORY = Object.freeze([
  inventoryEntry('extract.express.routeNodeId', 'src/pipeline/extract/frameworks/express.ts:86', 'source_location_derived'),
  inventoryEntry('extract.nest.routeNodeId', 'src/pipeline/extract/frameworks/nest.ts:326', 'source_location_derived'),
  inventoryEntry('extract.react-router.route', 'src/pipeline/extract/frameworks/react-router.ts:627', 'source_location_derived'),
  inventoryEntry('extract.go.chi-router-group', 'src/pipeline/extract/go-cross-file.ts:596', 'source_location_derived'),
  inventoryEntry('extract.go.net-http-route', 'src/pipeline/extract/go-cross-file.ts:654', 'source_location_derived'),
  inventoryEntry('extract.go.framework-route', 'src/pipeline/extract/go-cross-file.ts:702', 'source_location_derived'),
  inventoryEntry('extract.express.legacy-handler.541', 'src/pipeline/extract/frameworks/express.ts:541', 'source_location_derived'),
  inventoryEntry('extract.express.legacy-handler.1167', 'src/pipeline/extract/frameworks/express.ts:1167', 'source_location_derived'),
  inventoryEntry('extract.document-section.extract', 'src/pipeline/extract.ts:269', 'source_location_derived'),
  inventoryEntry('extract.document-section.non-code', 'src/pipeline/extract/non-code.ts:2595', 'source_location_derived'),
  inventoryEntry('extract.python-rationale', 'src/pipeline/extract/python-rationale.ts:117', 'source_location_derived'),
  inventoryEntry('extract.next.helper.90', 'src/pipeline/extract/frameworks/next.ts:90', 'absolute_workspace_path_derived'),
  inventoryEntry('extract.next.helper.95', 'src/pipeline/extract/frameworks/next.ts:95', 'absolute_workspace_path_derived'),
  inventoryEntry('extract.next.helper.99', 'src/pipeline/extract/frameworks/next.ts:99', 'absolute_workspace_path_derived'),
  inventoryEntry('extract.bibliography-reference.extract', 'src/pipeline/extract.ts:706', 'source_ordinal_derived'),
  inventoryEntry('extract.bibliography-reference.non-code', 'src/pipeline/extract/non-code.ts:3080', 'source_ordinal_derived'),
  inventoryEntry('extract.corpus-collision-stem', 'src/pipeline/extract/core.ts:68->114', 'collision_suffix_derived'),
  inventoryEntry('spi.express.synthetic-handler-name', 'src/pipeline/spi/framework-express.ts:421', 'adapter_local_synthetic_identity'),
  inventoryEntry('spi.prisma.synthetic.239', 'src/pipeline/spi/framework-prisma.ts:239', 'adapter_local_synthetic_identity'),
  inventoryEntry('spi.prisma.synthetic.246', 'src/pipeline/spi/framework-prisma.ts:246', 'adapter_local_synthetic_identity'),
] satisfies readonly EndpointConstructorIdentityInventoryEntry[])

const INVENTORY_BY_ID = new Map(ENDPOINT_CONSTRUCTOR_IDENTITY_INVENTORY.map((entry) => [entry.id, entry]))

export function classifyEndpointConstructor(constructorId: string): EndpointIdentityEndpointQualification {
  const classification = INVENTORY_BY_ID.get(constructorId)
  if (classification === undefined) {
    return Object.freeze({
      status: 'unknown',
      reasons: Object.freeze(['identity_policy_not_audited'] as const),
    })
  }
  return Object.freeze({
    status: classification.status,
    reasons: Object.freeze([classification.reason]),
  })
}

export function classifyLegacyEndpoint(): EndpointIdentityEndpointQualification {
  return Object.freeze({
    status: 'legacy',
    reasons: Object.freeze(['legacy_identity_policy'] as const),
  })
}

export function classifyEndpointIdentityPair(constructors: {
  readonly source: string
  readonly target: string
}): EndpointIdentityQualification {
  return Object.freeze({
    source: classifyEndpointConstructor(constructors.source),
    target: classifyEndpointConstructor(constructors.target),
  })
}
