import { GraphAdmissionError, InvalidGraphEndpointQualificationError, KnowledgeGraph, MissingGraphEndpointError } from '../contracts/graph.js'
import { classifyLegacyEndpoint } from '../contracts/endpoint-identity.js'
import {
  NormalizedAccountingSession,
  candidateFingerprint,
  type CandidateDisposition,
} from '../contracts/graph-integrity-session.js'
import type { IntegrityVerificationTarget, TerminalIntegrityReason } from '../contracts/graph-integrity.js'
import type { ExtractionData, ExtractionSchemaVersion } from '../contracts/types.js'
import { validateExtraction } from '../contracts/extraction.js'
import { normalizeExtractionData } from '../core/schema/normalize.js'
import { resolveRelationDiscriminator } from '../contracts/relation-discriminator.js'
import { isBuiltin } from 'node:module'
import { isRecord } from '../shared/guards.js'

type CombinedExtraction = {
  schema_version: ExtractionSchemaVersion
  nodes: ExtractionData['nodes']
  edges: ExtractionData['edges']
  hyperedges: NonNullable<ExtractionData['hyperedges']>
  input_tokens: number
  output_tokens: number
}

function mergeSchemaVersion(current: ExtractionData['schema_version'], next: ExtractionData['schema_version']): ExtractionSchemaVersion {
  if (current === 2 || next === 2) {
    return 2
  }

  return 1
}

/**
 * Whether this build owns the declared normalized extraction boundary.
 *
 * Default `'none'` on purpose. `buildFromJson` is reached by compatibility
 * callers as well as real builds -- `serve` reshapes a stored v1 artifact's
 * links into extraction shape and passes them straight through -- and an
 * opt-out default would let any such caller publish a receipt claiming
 * candidates it never extracted. Opting in is a reviewed decision per call
 * site; forgetting to opt in costs a ledger, forgetting to opt out fabricates
 * provenance.
 */
export type NormalizedAccountingMode = 'none' | 'normalized_extraction_boundary'

export interface BuildGraphOptions {
  directed?: boolean
  validateExtraction?: boolean
  accounting?: NormalizedAccountingMode
  /**
   * Absolute checkout root, supplied only by a build that truly knows it.
   *
   * Used for two things a candidate cannot determine on its own: refusing
   * endpoint identifiers that are the flattened checkout path, and turning
   * absolute producer `source_file` values into repository-relative
   * verification targets. Absent means neither happens -- an invented root
   * would be worse than none.
   */
  repositoryRoot?: string
}

type BuildableExtraction = {
  nodes: ExtractionData['nodes']
  edges: ExtractionData['edges']
  schema_version?: ExtractionData['schema_version']
  hyperedges?: ExtractionData['hyperedges']
  input_tokens?: number
  output_tokens?: number
}

function derivedEdgeConfidenceScore(attributes: Record<string, unknown>): number | undefined {
  if (typeof attributes.confidence_score === 'number' && Number.isFinite(attributes.confidence_score)) {
    return attributes.confidence_score
  }

  const confidence = typeof attributes.confidence === 'string' ? attributes.confidence : undefined
  switch (confidence) {
    case 'AMBIGUOUS':
      return 0.2
    case 'INFERRED':
      return 0.5
    case 'EXTRACTED':
      return 1
    default:
      return undefined
  }
}

interface UnresolvedEndpointInput {
  readonly source: string
  readonly target: string
  readonly sourceMissing: boolean
  readonly targetMissing: boolean
  readonly relation?: string
  readonly sourceFile?: unknown
  readonly rootPath?: string
}

/**
 * Hands the producer path to the verification-target policy unchanged.
 *
 * This used to relativize here and gate on `relativized.startsWith('..')`,
 * which discarded an in-root directory literally named `..fixtures` as if it
 * were an escape. Root conversion and traversal detection now live in one
 * segment-aware owner, so a path is judged once by path semantics rather than
 * twice by two different string rules.
 */
function unresolvedEndpoint(input: UnresolvedEndpointInput): CandidateDisposition {
  const reasons: TerminalIntegrityReason[] = []
  if (input.sourceMissing && input.targetMissing) {
    reasons.push('missing_both_endpoints')
  } else if (input.sourceMissing) {
    reasons.push('missing_source_endpoint')
  } else {
    reasons.push('missing_target_endpoint')
  }
  if (input.targetMissing && isBuiltin(input.target)) {
    reasons.push('unresolved_external_module_boundary')
  }

  // Raw producer path in; the sanitizer owns conversion, bounding and refusal.
  const targets: IntegrityVerificationTarget[] = typeof input.sourceFile === 'string'
    ? [{ file: input.sourceFile, reason: reasons[0]! }]
    : []

  return {
    state: 'unresolved',
    reasons,
    source: input.source,
    target: input.target,
    ...(input.relation !== undefined ? { relation: input.relation } : {}),
    verificationTargets: targets,
  }
}

/**
 * Admits a candidate through the storage boundary and maps the result to a
 * terminal state.
 *
 * The registry is deliberately **not** pre-checked here. Letting `addEdge` make
 * every unsupported-relation determination is what keeps #657's
 * `storage_admission` counter and this ledger's `unsupported_relation` bucket
 * equal; a pre-check that skipped the call would count a rejection the storage
 * boundary never saw.
 */
function admitCandidate(
  graph: KnowledgeGraph,
  source: string,
  target: string,
  attributes: Record<string, unknown>,
  candidate: unknown,
): CandidateDisposition {
  let admission
  try {
    admission = graph.addEdge(source, target, attributes as never)
  } catch (error) {
    if (error instanceof MissingGraphEndpointError) {
      // Unreachable through this path -- endpoints are checked above -- so
      // reaching it means the node set and the store disagree.
      return { state: 'invariant_failed', reasons: ['candidate_accounting_mismatch'], candidate }
    }
    if (error instanceof InvalidGraphEndpointQualificationError) {
      return { state: 'rejected', reasons: ['malformed_endpoint_identity'], candidate }
    }
    if (error instanceof GraphAdmissionError) {
      return { state: 'rejected', reasons: ['malformed_discriminator'], candidate }
    }
    throw error
  }

  if (admission.status === 'unresolved_degraded') {
    return { state: 'rejected', reasons: ['unsupported_relation'], candidate }
  }

  const reasons: TerminalIntegrityReason[] = []
  if (relationDiscriminatorCompleteness(attributes.relation) === 'partial') {
    // Visible degradation on a retained fact: the registry has a policy for
    // this relation but the producer does not supply the behaviour data it
    // names. Retained, not dropped -- and not silently clean either.
    reasons.push('partial_discriminator')
  }

  if (!admission.duplicate) {
    return { state: 'retained_new_fact', reasons }
  }
  // The fact already existed. Whether this candidate contributed a distinct
  // observation or was an exact repeat is the difference between
  // `retained_additional_occurrence` and `deliberately_merged_duplicate`, and
  // only the occurrence disposition can tell them apart.
  return {
    state: admission.occurrenceDisposition === 'inserted'
      ? 'retained_additional_occurrence'
      : 'deliberately_merged_duplicate',
    reasons,
  }
}

function relationDiscriminatorCompleteness(relation: unknown): 'partial' | 'endpoint_only' | 'full' | null {
  if (typeof relation !== 'string') return null
  const resolution = resolveRelationDiscriminator(relation)
  return resolution.status === 'registered' ? resolution.discriminator.completeness : null
}

export function buildFromJson(extraction: unknown, options: BuildGraphOptions = {}): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: options.directed === true })
  if (!isRecord(extraction)) {
    return graph
  }

  const normalized = normalizeExtractionData(extraction)
  if (options.validateExtraction !== false) {
    const errors = validateExtraction(extraction)
    const nonDanglingErrors = errors.filter((error) => !error.includes('does not match any node id'))

    if (nonDanglingErrors.length > 0) {
      console.warn(`[madar] Extraction warning (${nonDanglingErrors.length} issues): ${nonDanglingErrors[0]}`)
    }

    const normalizedErrors = validateExtraction(normalized)
    const postNormalizationErrors = normalizedErrors
      .filter((error) => !errors.includes(error))
      .filter((error) => !error.includes('does not match any node id'))

    if (postNormalizationErrors.length > 0) {
      console.warn(`[madar] Normalization warning (${postNormalizationErrors.length} issues): ${postNormalizationErrors[0]}`)
    }
  }

  const nodes = normalized.nodes
  const legacyQualification = normalized.schema_version === 1 ? classifyLegacyEndpoint() : null
  for (const node of nodes) {
    const { id, ...attributes } = node
    if (typeof id === 'string') {
      graph.addNode(id, legacyQualification === null
        ? attributes
        : { ...attributes, endpointIdentity: legacyQualification })
    }
  }

  const nodeIds = new Set(graph.nodeIds())
  // The declared normalized extraction boundary. One entry of the extraction's
  // `edges` array is one normalized candidate, and every entry reaches exactly
  // one terminal state. Before #658 an entry whose endpoints were absent was
  // skipped with a bare `continue`, leaving no counter, record or diagnostic --
  // 412 of 14,556 candidates on Madar's own corpus disappeared that way.
  const rawEdges: readonly unknown[] = Array.isArray(extraction.edges) ? extraction.edges : []
  // A session is created only when this build owns the boundary. Compatibility
  // callers get no ledger at all rather than an empty or fabricated one.
  // A truthful root may also arrive on the extraction itself; an explicit
  // option wins because the caller knows more than the payload.
  const repositoryRoot = options.repositoryRoot
    ?? (typeof extraction.root_path === 'string' && extraction.root_path.trim().length > 0
      ? extraction.root_path
      : undefined)
  const session = options.accounting === 'normalized_extraction_boundary'
    ? new NormalizedAccountingSession(repositoryRoot !== undefined ? { repositoryRoot } : {})
    : null
  let normalizedCursor = 0

  for (const [index, rawEdge] of rawEdges.entries()) {
    if (!isRecord(rawEdge)) {
      // `normalizeExtractionData` drops non-record entries before they ever
      // acquire a candidate shape. Accounted here rather than silently filtered.
      session?.dispose(candidateFingerprint({ index }), {
        state: 'rejected',
        reasons: ['malformed_candidate'],
        candidate: rawEdge,
      })
      continue
    }

    // The normalizer filters non-records and then maps one-to-one, so the
    // normalized array is the subsequence of record entries in order. Asserted
    // below rather than assumed, so a future normalizer change cannot silently
    // desynchronise the correlation.
    const normalizedEdge = normalized.edges[normalizedCursor]
    normalizedCursor += 1
    if (normalizedEdge === undefined) {
      session?.dispose(candidateFingerprint({ index }), {
        state: 'invariant_failed',
        reasons: ['candidate_accounting_mismatch'],
        candidate: rawEdge,
      })
      continue
    }

    const source = typeof normalizedEdge.source === 'string' ? normalizedEdge.source : null
    const target = typeof normalizedEdge.target === 'string' ? normalizedEdge.target : null
    const relation = typeof normalizedEdge.relation === 'string' ? normalizedEdge.relation : undefined
    const fingerprint = candidateFingerprint({
      index,
      ...(source !== null ? { source } : {}),
      ...(target !== null ? { target } : {}),
      ...(relation !== undefined ? { relation } : {}),
    })

    if (source === null || target === null) {
      session?.dispose(fingerprint, {
        state: 'rejected',
        reasons: ['malformed_candidate'],
        candidate: normalizedEdge,
      })
      continue
    }

    const sourceMissing = !nodeIds.has(source)
    const targetMissing = !nodeIds.has(target)
    if (sourceMissing || targetMissing) {
      session?.dispose(fingerprint, unresolvedEndpoint({
        source,
        target,
        sourceMissing,
        targetMissing,
        ...(relation !== undefined ? { relation } : {}),
        sourceFile: normalizedEdge.source_file,
        ...(repositoryRoot !== undefined ? { rootPath: repositoryRoot } : {}),
      }))
      continue
    }

    const { source: _source, target: _target, ...attributes } = normalizedEdge
    const confidenceScore = derivedEdgeConfidenceScore(attributes)
    // Admission must happen whether or not this build keeps a ledger: with
    // optional chaining the argument would not even be evaluated, and a
    // compatibility load would silently build an edgeless graph.
    const disposition = admitCandidate(graph, source, target, {
      ...attributes,
      ...(confidenceScore !== undefined ? { confidence_score: confidenceScore } : {}),
      _src: source,
      _tgt: target,
    }, normalizedEdge)
    session?.dispose(fingerprint, disposition)
  }

  if (normalizedCursor !== normalized.edges.length) {
    // The subsequence assumption above no longer holds. Failing closed beats
    // publishing a ledger built on a correlation that silently drifted.
    throw new GraphAdmissionError(
      `normalized edge correlation drifted: consumed ${normalizedCursor} of ${normalized.edges.length}`,
    )
  }

  if (session !== null) graph.attachNormalizedAccounting(session.finalize())

  const hyperedges = normalized.hyperedges
  if (hyperedges.length > 0) {
    graph.graph.hyperedges = hyperedges
  }
  graph.graph.schema_version = normalized.schema_version
  graph.graph.directed = graph.isDirected()
  if (typeof extraction.root_path === 'string' && extraction.root_path.trim().length > 0) {
    graph.graph.root_path = extraction.root_path
  }
  if (extraction.spi_mode === true) {
    graph.graph.spi_mode = true
  }
  if (isRecord(extraction.graph_build_freshness)) {
    graph.graph.graph_build_freshness = extraction.graph_build_freshness
  }

  return graph
}

export function build(extractions: BuildableExtraction[], options: BuildGraphOptions = {}): KnowledgeGraph {
  const combined: CombinedExtraction = {
    schema_version: 1,
    nodes: [],
    edges: [],
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  }

  for (const extraction of extractions) {
    combined.schema_version = mergeSchemaVersion(combined.schema_version, extraction.schema_version)
    combined.nodes.push(...extraction.nodes)
    combined.edges.push(...extraction.edges)
    combined.hyperedges.push(...(extraction.hyperedges ?? []))
    combined.input_tokens += typeof extraction.input_tokens === 'number' ? extraction.input_tokens : 0
    combined.output_tokens += typeof extraction.output_tokens === 'number' ? extraction.output_tokens : 0
  }

  return buildFromJson(combined, options)
}
