import { describe, expect, it } from 'vitest'

import { serializeCanonicalJson } from '../../src/contracts/canonical-json.js'
import type { EndpointIdentityStatus } from '../../src/contracts/endpoint-identity.js'
import {
  NORMALIZED_ACCOUNTING_ARTIFACT_KEY,
  NORMALIZED_ACCOUNTING_KEYS,
  NORMALIZED_RECEIPT_KEYS,
  normalizedAccountingStructureError,
  SUPPORTED_GRAPH_ARTIFACT_VERSIONS,
  v2PayloadStructureError,
  GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION,
  GRAPH_ARTIFACT_VERSION,
} from '../../src/contracts/graph-artifact-payload.js'
import {
  GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION as WRITER_RECEIPT_STORAGE_SCHEMA_VERSION,
  GRAPH_ARTIFACT_VERSION as WRITER_ARTIFACT_VERSION,
  GRAPH_ARTIFACT_V2_HEADER,
} from '../../src/contracts/graph-artifact.js'
import {
  GENERATION_STRICT_MODE_RESULT,
  assertGraphArtifactNormalizedAccounting,
  assertNormalizedEndpointIdentityMatchesStorage,
  assertNormalizedReceiptMatchesGraphTotals,
  buildGraphArtifactNormalizedAccounting,
  normalizedAccountingResultFromArtifact,
  parseGraphArtifactNormalizedAccounting,
  type GraphArtifactNormalizedAccountingV1,
} from '../../src/contracts/graph-artifact-normalized-accounting.js'
import { GraphIntegrityInvariantError } from '../../src/contracts/graph-integrity.js'
import type { KnowledgeGraph } from '../../src/contracts/graph.js'
import { buildFromJson } from '../../src/pipeline/build.js'

function extraction(): Record<string, unknown> {
  return {
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
      { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
      { id: 'gamma', label: 'Gamma', file_type: 'code', source_file: 'src/gamma.ts' },
    ],
    edges: [
      { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      { source: 'beta', target: 'gamma', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
      { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      { source: 'beta', target: 'gamma', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
    ],
  }
}

function built(): KnowledgeGraph {
  return buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
}

function block(): GraphArtifactNormalizedAccountingV1 {
  return buildGraphArtifactNormalizedAccounting(built().normalizedIntegritySnapshot()!)
}

/** A block with more than one unresolved record, so ordering is observable. */
function multiUnresolvedBlock(): GraphArtifactNormalizedAccountingV1 {
  const source = extraction()
  const edges = source.edges as Record<string, unknown>[]
  source.edges = [
    ...edges,
    { source: 'gamma', target: 'elsewhere', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/gamma.ts' },
    { source: 'beta', target: 'vanished', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
  ]
  const graph = buildFromJson(source, { directed: true, accounting: 'normalized_extraction_boundary' })
  return buildGraphArtifactNormalizedAccounting(graph.normalizedIntegritySnapshot()!)
}

/** A mutable deep clone, which is what a decoded artifact hands a reader. */
function decoded(value: unknown = block()): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

const FIELD = NORMALIZED_ACCOUNTING_ARTIFACT_KEY

describe('S3-1 — artifact identity does not move for the additive block', () => {
  it('keeps one declaration of the artifact version for writer and classifier', () => {
    // Two declarations could drift, and a bump on one side would advertise a
    // different version for the same bytes.
    expect(WRITER_ARTIFACT_VERSION).toBe(GRAPH_ARTIFACT_VERSION)
    expect(WRITER_RECEIPT_STORAGE_SCHEMA_VERSION).toBe(GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION)
  })

  it('keeps artifact v2 and receipt storage schema 1', () => {
    expect(GRAPH_ARTIFACT_VERSION).toBe(2)
    expect(GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION).toBe(1)
    expect(GRAPH_ARTIFACT_V2_HEADER).toBe('MADAR_GRAPH_ARTIFACT/2\n')
  })

  it('names the additive key inside the storage receipt', () => {
    expect(NORMALIZED_ACCOUNTING_ARTIFACT_KEY).toBe('normalized_accounting')
  })

  it('records strict mode as not run at generation', () => {
    // Strict eligibility is a load-time decision. Baking a verdict into the
    // bytes would make a later policy change require rewriting artifacts that
    // did not themselves change.
    expect(GENERATION_STRICT_MODE_RESULT).toBe('not_run')
    expect(block().receipt.strict_mode_result).toBe('not_run')
  })
})

describe('S3-1 — the block is a closed schema', () => {
  it('carries exactly the declared keys', () => {
    expect(Object.keys(block()).sort()).toEqual([...NORMALIZED_ACCOUNTING_KEYS].sort())
  })

  it('carries an empty reserved block', () => {
    expect(block().reserved).toEqual({})
  })

  it('carries exactly the declared receipt keys', () => {
    expect(Object.keys(block().receipt).sort()).toEqual([...NORMALIZED_RECEIPT_KEYS].sort())
  })

  it('is JSON-safe and canonicalizable', () => {
    expect(() => serializeCanonicalJson(block() as never, { arraySemantics: 'ordered' })).not.toThrow()
  })

  it('survives a JSON round trip unchanged', () => {
    const original = block()
    expect(decoded(original)).toEqual(JSON.parse(JSON.stringify(original)))
    expect(() => assertGraphArtifactNormalizedAccounting(decoded(original), FIELD)).not.toThrow()
  })

  it('refuses an unknown top-level field', () => {
    const tampered = decoded()
    tampered.extra = 1
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('refuses a missing required field', () => {
    for (const key of NORMALIZED_ACCOUNTING_KEYS) {
      const tampered = decoded()
      delete tampered[key]
      expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD), `missing ${key}`)
        .toThrow(GraphIntegrityInvariantError)
    }
  })

  it('refuses an unknown field inside the receipt', () => {
    const tampered = decoded()
    ;(tampered.receipt as Record<string, unknown>).extra = 1
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('refuses a non-empty reserved block', () => {
    const tampered = decoded()
    tampered.reserved = { later: true }
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('refuses an accessor where a data property is declared', () => {
    const tampered = decoded()
    Object.defineProperty(tampered, 'scope_failures', {
      get: () => [],
      enumerable: true,
      configurable: true,
    })
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('refuses a symbol key', () => {
    const tampered = decoded()
    ;(tampered as Record<symbol, unknown>)[Symbol('hidden')] = 1
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('refuses a custom prototype', () => {
    class Impostor {}
    const tampered = Object.assign(new Impostor(), decoded())
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })
})

describe('S3-1 — the receipt keeps its one authority', () => {
  it('derives a status that agrees with its own counters', () => {
    expect(block().receipt.status).toBe(built().normalizedIntegritySnapshot()!.status)
  })

  it('refuses a forged valid status', () => {
    const tampered = decoded()
    ;(tampered.receipt as Record<string, unknown>).status = 'valid'
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/disagrees with its own counters/)
  })

  it('refuses a wrong receipt version', () => {
    const tampered = decoded()
    ;(tampered.receipt as Record<string, unknown>).receipt_version = 2
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/unsupported receipt_version/)
  })

  it('refuses a wrong reason vocabulary version', () => {
    const tampered = decoded()
    ;(tampered.receipt as Record<string, unknown>).reason_vocabulary_version = 2
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/unsupported reason_vocabulary_version/)
  })

  it('refuses a wrong accounting scope', () => {
    const tampered = decoded()
    ;(tampered.receipt as Record<string, unknown>).accounting_scope = 'storage_only'
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/accounting_scope must be/)
  })

  it('refuses a candidate equation that does not balance', () => {
    const tampered = decoded()
    ;(tampered.receipt as Record<string, unknown>).emitted_candidates = 99
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('refuses reasons that disagree with the receipt they describe', () => {
    const tampered = decoded()
    ;(tampered.receipt as Record<string, unknown>).reasons = ['full_emission_accounting_not_available']
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('refuses a strict_mode_result of pass beside a degraded status', () => {
    const tampered = decoded()
    ;(tampered.receipt as Record<string, unknown>).strict_mode_result = 'pass'
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/strict_mode_result cannot be pass/)
  })
})

describe('S3-1 — records are validated, ordered and accounted for', () => {
  it('carries every retained record', () => {
    const snapshot = built().normalizedIntegritySnapshot()!
    const wire = block()
    expect(wire.unresolved_records.length).toBe(snapshot.unresolvedRecords.length)
    expect(wire.rejected_records.length).toBe(snapshot.rejectedRecords.length)
    expect(wire.conflict_records.length).toBe(snapshot.conflictRecords.length)
    expect(wire.unresolved_records.length).toBeGreaterThan(0)
    expect(wire.rejected_records.length).toBeGreaterThan(0)
  })

  it('orders every record array by record id', () => {
    for (const records of [block().unresolved_records, block().rejected_records, block().conflict_records]) {
      const ids = records.map((record) => record.id)
      expect(ids).toEqual([...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
    }
  })

  it('refuses an unordered record array rather than sorting it', () => {
    // Deterministic bytes are the contract. Repairing the order on read would
    // hide exactly the divergence the contract exists to expose.
    const tampered = decoded(multiUnresolvedBlock())
    const records = tampered.unresolved_records as Record<string, unknown>[]
    expect(records.length).toBeGreaterThan(1)
    tampered.unresolved_records = [...records].reverse()
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/is not in canonical order at index 1/)
  })

  it('refuses a duplicate record id', () => {
    const tampered = decoded(multiUnresolvedBlock())
    const records = tampered.unresolved_records as Record<string, unknown>[]
    tampered.unresolved_records = [records[0], records[0]]
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/contains a duplicate entry/)
  })

  it('refuses a record in the wrong array', () => {
    const tampered = decoded()
    tampered.rejected_records = [(tampered.unresolved_records as unknown[])[0]]
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/is a unresolved record in the rejected array/)
  })

  it('refuses a record array whose length disagrees with the retention it claims', () => {
    const tampered = decoded()
    tampered.unresolved_records = []
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/carries 0 records but the receipt claims 1 retained/)
  })

  it('refuses a tampered record payload', () => {
    const tampered = decoded()
    const record = (tampered.rejected_records as Record<string, unknown>[])[0]!
    record.sanitizedCandidate = { forged: 'value' }
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/does not match the record's own identity payload/)
  })

  it('refuses a non-canonical record identity', () => {
    const tampered = decoded()
    const record = (tampered.unresolved_records as Record<string, unknown>[])[0]!
    record.id = 'uc_not-a-sha'
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/followed by a full lowercase SHA-256/)
  })

  it('refuses an unsafe endpoint hint smuggled into a record', () => {
    const tampered = decoded()
    const record = (tampered.unresolved_records as Record<string, unknown>[])[0]!
    record.source = '/Users/someone/secret/project/src/alpha.ts'
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/is not share-safe/)
  })
})

describe('S3-1 — scope failures keep their canonical order and exact accounting', () => {
  it('refuses an unordered scope failure list', () => {
    const tampered = decoded()
    tampered.scope_failures = ['zeta', 'alpha']
    tampered.scope_failure_retention = { retained: 2, total: 2, omitted: 0, truncated: false }
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/not in canonical order/)
  })

  it('refuses a scope failure retention that does not match the list', () => {
    const tampered = decoded()
    tampered.scope_failures = ['alpha']
    tampered.scope_failure_retention = { retained: 4, total: 4, omitted: 0, truncated: false }
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(/claims 4 retained/)
  })

  it('refuses retention arithmetic that does not close', () => {
    const tampered = decoded()
    tampered.scope_failure_retention = { retained: 0, total: 4, omitted: 0, truncated: false }
    expect(() => assertGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })
})

describe('S3-1 — cross-boundary reconciliation', () => {
  it('agrees with the graph totals it was built from', () => {
    const graph = built()
    const receipt = buildGraphArtifactNormalizedAccounting(graph.normalizedIntegritySnapshot()!).receipt
    expect(() => assertNormalizedReceiptMatchesGraphTotals(receipt, {
      facts: graph.numberOfFacts(),
      occurrences: graph.numberOfOccurrences(),
      endpointPairs: graph.numberOfEndpointPairs(),
    })).not.toThrow()
  })

  it('refuses a graph whose totals disagree with the receipt', () => {
    const graph = built()
    const receipt = buildGraphArtifactNormalizedAccounting(graph.normalizedIntegritySnapshot()!).receipt
    expect(() => assertNormalizedReceiptMatchesGraphTotals(receipt, {
      facts: graph.numberOfFacts() + 1,
      occurrences: graph.numberOfOccurrences(),
      endpointPairs: graph.numberOfEndpointPairs(),
    })).toThrow(/facts_retained is 2 but the graph holds 3/)
  })

  it('agrees with the storage receipt endpoint identity projection', () => {
    const graph = built()
    const receipt = buildGraphArtifactNormalizedAccounting(graph.normalizedIntegritySnapshot()!).receipt
    expect(() => assertNormalizedEndpointIdentityMatchesStorage(receipt, {
      fact_pair_counts: graph.endpointIdentityMatrix(),
      reason_fact_counts: graph.endpointReasonFactSummary(),
    })).not.toThrow()
  })

  it('refuses an endpoint matrix that disagrees with storage', () => {
    const graph = built()
    const receipt = buildGraphArtifactNormalizedAccounting(graph.normalizedIntegritySnapshot()!).receipt
    const matrix = JSON.parse(
      JSON.stringify(graph.endpointIdentityMatrix()),
    ) as Record<EndpointIdentityStatus, Record<EndpointIdentityStatus, number>>
    matrix.stable.stable = 7
    expect(() => assertNormalizedEndpointIdentityMatchesStorage(receipt, {
      fact_pair_counts: matrix,
      reason_fact_counts: graph.endpointReasonFactSummary(),
    })).toThrow(/disagrees with the storage receipt at stable\/stable/)
  })

  it('refuses an endpoint reason count that disagrees with storage', () => {
    const graph = built()
    const receipt = buildGraphArtifactNormalizedAccounting(graph.normalizedIntegritySnapshot()!).receipt
    expect(() => assertNormalizedEndpointIdentityMatchesStorage(receipt, {
      fact_pair_counts: graph.endpointIdentityMatrix(),
      reason_fact_counts: { ...graph.endpointReasonFactSummary(), legacy_identity_policy: 99 },
    })).toThrow(/endpoint reason count for "legacy_identity_policy"/)
  })

  it('projects storage admission rather than adding it', () => {
    // The unregistered relation is refused once, inside addEdge, and classified
    // once, at the normalized boundary. They must be the same event.
    const graph = built()
    expect(graph.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates)
      .toBe(block().receipt.unsupported_relations)
  })
})

describe('S3-1 — the block reads back as the accounting it describes', () => {
  it('rebuilds an accounting result that agrees with the receipt', () => {
    const wire = block()
    const result = normalizedAccountingResultFromArtifact(wire)
    expect(result.emittedCandidates).toBe(wire.receipt.emitted_candidates)
    expect(result.counts).toEqual(wire.receipt.terminal_counts)
    expect(result.terminalReasonCounts).toEqual(wire.receipt.terminal_reason_counts)
    expect(result.unresolvedRecords).toBe(wire.unresolved_records)
    expect(result.recordRetention.unresolved).toEqual(wire.receipt.durable_records.unresolved)
    expect(result.scopeFailures).toBe(wire.scope_failures)
  })

  it('claims no flattened root it never saw', () => {
    // The root belongs to the machine that produced the artifact. A reader that
    // invented one would assert a redaction it cannot verify.
    expect(normalizedAccountingResultFromArtifact(block()).flattenedRoot).toBeNull()
  })

  it('parses a valid decoded block', () => {
    expect(() => parseGraphArtifactNormalizedAccounting(decoded(), FIELD)).not.toThrow()
  })

  it('parses through the same structural gate the classifier uses', () => {
    const tampered = decoded()
    delete tampered.receipt
    expect(normalizedAccountingStructureError(tampered, FIELD)).not.toBeNull()
    expect(() => parseGraphArtifactNormalizedAccounting(tampered, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })
})

describe('S3-1 — the classifier and the parser answer structure identically', () => {
  function payload(normalized: unknown): Record<string, unknown> {
    return {
      versions: { ...SUPPORTED_GRAPH_ARTIFACT_VERSIONS },
      directed: true,
      community_labels: {},
      repository_revision: 'rev',
      generation_mode: 'full',
      generated_at: 'now',
      nodes: [],
      facts: [],
      occurrences: [],
      hyperedges: [],
      integrity_receipt: { [NORMALIZED_ACCOUNTING_ARTIFACT_KEY]: normalized },
      reserved: {},
    }
  }

  it('accepts a payload with no normalized accounting at all', () => {
    // Every artifact written before #658 looks exactly like this, and it stays
    // a perfectly good storage-only v2.
    const withoutBlock = payload(undefined)
    withoutBlock.integrity_receipt = {}
    expect(v2PayloadStructureError(withoutBlock)).toBeNull()
  })

  it('accepts a payload carrying a valid normalized block', () => {
    expect(v2PayloadStructureError(payload(decoded()))).toBeNull()
  })

  it('refuses a structurally malformed normalized block at classification time', () => {
    expect(v2PayloadStructureError(payload({ receipt: {} }))).toMatch(/is missing required field/)
    expect(v2PayloadStructureError(payload(null))).toMatch(/must be an object/)
  })

  it('refuses an unknown normalized key at classification time', () => {
    const wire = decoded()
    wire.surprise = true
    expect(v2PayloadStructureError(payload(wire))).toMatch(/carries unknown field "surprise"/)
  })

  it('refuses a non-empty reserved block at classification time', () => {
    const wire = decoded()
    wire.reserved = { later: true }
    expect(v2PayloadStructureError(payload(wire))).toMatch(/reserved and must be empty/)
  })
})
