import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  GRAPH_ARTIFACT_V2_HEADER,
  parseGraphArtifactV2,
  serializeGraphArtifactV2,
  type GraphArtifactIntegrityReceipt,
} from '../../src/contracts/graph-artifact.js'
import { NORMALIZED_ACCOUNTING_ARTIFACT_KEY } from '../../src/contracts/graph-artifact-payload.js'
import { GraphIntegrityInvariantError } from '../../src/contracts/graph-integrity.js'
import { activateGraphArtifactV2InDirectory } from '../../src/infrastructure/graph-artifact-activation.js'
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

/** A graph carrying a finalized normalized snapshot. */
function accounted(): KnowledgeGraph {
  return buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
}

/** The same corpus built with no normalized accounting at all. */
function unaccounted(): KnowledgeGraph {
  return buildFromJson(extraction(), { directed: true })
}

const FIXED = {
  repositoryRevision: 'rev-fixed',
  generationMode: 'full',
  generatedAt: '2026-08-24T00:00:00.000Z',
} as const

function serialize(graph: KnowledgeGraph): Buffer {
  return serializeGraphArtifactV2({ graph, ...FIXED })
}

function receiptOf(graph: KnowledgeGraph): GraphArtifactIntegrityReceipt {
  return parseGraphArtifactV2(serialize(graph)).integrity_receipt as GraphArtifactIntegrityReceipt
}

describe('S3-2 — the block is emitted exactly when a snapshot exists', () => {
  it('emits normalized accounting for an accounted build', () => {
    expect(receiptOf(accounted())).toHaveProperty(NORMALIZED_ACCOUNTING_ARTIFACT_KEY)
  })

  it('omits the key entirely when no normalized boundary ran', () => {
    // Absence is not zero. `--cluster-only`, graph reuse and v1 rehydration all
    // reach here, and a zeroed receipt would describe a run that never happened.
    const receipt = receiptOf(unaccounted())
    expect(Object.keys(receipt)).not.toContain(NORMALIZED_ACCOUNTING_ARTIFACT_KEY)
    expect(receipt.normalized_accounting).toBeUndefined()
  })

  it('omits the key for an empty graph with no build behind it', () => {
    expect(Object.keys(receiptOf(new KnowledgeGraph({ directed: true }))))
      .not.toContain(NORMALIZED_ACCOUNTING_ARTIFACT_KEY)
  })

  it('omits the key once a mutation has invalidated the snapshot', () => {
    const graph = accounted()
    graph.addNode('delta', { label: 'Delta', file_type: 'code' })
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
    expect(Object.keys(receiptOf(graph))).not.toContain(NORMALIZED_ACCOUNTING_ARTIFACT_KEY)
  })
})

describe('S3-2 — the storage receipt is unchanged by the addition', () => {
  it('keeps every storage field and its meaning', () => {
    const receipt = receiptOf(accounted())
    expect(receipt.accounting_scope).toBe('storage_only')
    expect(receipt.status).toBe('degraded')
    expect(receipt.reasons).toContain('full_emission_accounting_not_available')
    expect(receipt.reserved).toEqual({})
    expect(receipt.storage_admission.unresolved_unregistered_relation_candidates).toBe(1)
  })

  it('serializes an identical storage receipt with and without the block', () => {
    // Byte compatibility for old readers is exactly this: the storage half of
    // the receipt must not move because accounting was added beside it.
    const withBlock = receiptOf(accounted()) as unknown as Record<string, unknown>
    const withoutBlock = receiptOf(unaccounted()) as unknown as Record<string, unknown>
    const { [NORMALIZED_ACCOUNTING_ARTIFACT_KEY]: _accounting, ...storageOnly } = withBlock
    expect(storageOnly).toEqual(withoutBlock)
  })

  it('leaves the bytes of an unaccounted graph unchanged from artifact v2', () => {
    // The whole payload, not only the receipt: adding an optional key must not
    // perturb an artifact that does not carry it.
    const text = serialize(unaccounted()).toString('utf8')
    expect(text.startsWith(GRAPH_ARTIFACT_V2_HEADER)).toBe(true)
    expect(text).not.toContain(NORMALIZED_ACCOUNTING_ARTIFACT_KEY)
  })

  it('keeps the declared versions', () => {
    const payload = parseGraphArtifactV2(serialize(accounted()))
    expect(payload.versions.graph_artifact).toBe(2)
    expect(payload.versions.receipt_storage_schema).toBe(1)
  })
})

describe('S3-2 — endpoint identity is one number on both sides', () => {
  it('counts a fact once per applicable reason, not once per endpoint', () => {
    // Both endpoints of every fact in this corpus carry `legacy_identity_policy`.
    // Counting per endpoint made the graph's incremental counter report double
    // what #657's storage walk reports for the same facts.
    const graph = accounted()
    const receipt = receiptOf(graph)
    expect(graph.numberOfFacts()).toBe(2)
    expect(graph.endpointReasonFactSummary().legacy_identity_policy).toBe(2)
    expect(receipt.endpoint_identity.reason_fact_counts.legacy_identity_policy).toBe(2)
    expect(receipt.normalized_accounting!.receipt.endpoint_identity.reason_fact_counts)
      .toEqual(receipt.endpoint_identity.reason_fact_counts)
  })

  it('agrees cell for cell with the storage matrix', () => {
    const receipt = receiptOf(accounted())
    expect(receipt.normalized_accounting!.receipt.endpoint_identity.fact_pair_counts)
      .toEqual(receipt.endpoint_identity.fact_pair_counts)
  })

  it('agrees for an undirected graph, where orientation could differ', () => {
    // The storage walk re-orients undirected facts to their identity
    // orientation; the graph's counter reads the stored orientation. They must
    // still land in the same cell.
    const undirectedSource = { ...extraction(), directed: false }
    const graph = buildFromJson(undirectedSource, {
      directed: false,
      accounting: 'normalized_extraction_boundary',
    })
    const receipt = parseGraphArtifactV2(serializeGraphArtifactV2({ graph, ...FIXED }))
      .integrity_receipt as GraphArtifactIntegrityReceipt
    expect(receipt.normalized_accounting!.receipt.endpoint_identity.fact_pair_counts)
      .toEqual(receipt.endpoint_identity.fact_pair_counts)
    expect(receipt.normalized_accounting!.receipt.endpoint_identity.reason_fact_counts)
      .toEqual(receipt.endpoint_identity.reason_fact_counts)
  })
})

describe('S3-2 — bytes are deterministic', () => {
  it('produces byte-identical output for the same graph and generated_at', () => {
    const graph = accounted()
    expect(serialize(graph).equals(serialize(graph))).toBe(true)
  })

  it('produces byte-identical output for two equivalent builds', () => {
    expect(serialize(accounted()).equals(serialize(accounted()))).toBe(true)
  })

  it('does not reorder the snapshot it was handed', () => {
    // The snapshot is deep-frozen graph state. A serializer that sorted in
    // place would change what every later reader of the same graph sees.
    const graph = accounted()
    const before = graph.normalizedIntegritySnapshot()!
    const ids = before.unresolvedRecords.map((record) => record.id)
    serialize(graph)
    expect(graph.normalizedIntegritySnapshot()).toBe(before)
    expect(before.unresolvedRecords.map((record) => record.id)).toEqual(ids)
  })
})

describe('S3-2 — serialization performs no second accumulation', () => {
  /** Counts the graph reads a serialization actually makes. */
  function countReads(graph: KnowledgeGraph): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const method of [
      'factRecords', 'occurrenceEntries', 'nodeEntries', 'storageAdmissionSummary',
      'normalizedIntegritySnapshot', 'endpointIdentityMatrix', 'endpointReasonFactSummary',
      'numberOfFacts', 'numberOfOccurrences', 'numberOfEndpointPairs',
    ] as const) {
      counts[method] = 0
      const original = graph[method].bind(graph)
      vi.spyOn(graph, method).mockImplementation(((...args: never[]) => {
        counts[method] = (counts[method] ?? 0) + 1
        return (original as (...inner: never[]) => unknown)(...args)
      }) as never)
    }
    serialize(graph)
    vi.restoreAllMocks()
    return counts
  }

  it('walks facts and occurrences exactly once, with or without accounting', () => {
    const withAccounting = countReads(accounted())
    const withoutAccounting = countReads(unaccounted())
    expect(withAccounting.factRecords).toBe(1)
    expect(withAccounting.occurrenceEntries).toBe(1)
    expect(withAccounting.nodeEntries).toBe(1)
    expect(withAccounting.factRecords).toBe(withoutAccounting.factRecords)
    expect(withAccounting.occurrenceEntries).toBe(withoutAccounting.occurrenceEntries)
    expect(withAccounting.nodeEntries).toBe(withoutAccounting.nodeEntries)
  })

  it('reads the finalized snapshot rather than rebuilding one', () => {
    const counts = countReads(accounted())
    expect(counts.normalizedIntegritySnapshot).toBe(1)
    // The matrix and reason summary are the graph's O(1) counters. Rebuilding
    // the endpoint matrix from a fact walk is exactly the second accumulation
    // Stage 3 is not allowed to spend.
    expect(counts.endpointIdentityMatrix).toBe(0)
    expect(counts.endpointReasonFactSummary).toBe(0)
  })

  it('uses the O(1) totals for reconciliation', () => {
    const counts = countReads(accounted())
    expect(counts.numberOfFacts).toBe(1)
    expect(counts.numberOfOccurrences).toBe(1)
    expect(counts.numberOfEndpointPairs).toBe(1)
  })
})

describe('S3-2 — invalid accounting does not reach the bytes', () => {
  it('refuses a snapshot whose stored status disagrees with its counters', () => {
    const graph = accounted()
    const snapshot = graph.normalizedIntegritySnapshot()!
    vi.spyOn(graph, 'normalizedIntegritySnapshot')
      .mockReturnValue({ ...snapshot, status: 'valid' } as never)
    expect(() => serialize(graph)).toThrow(GraphIntegrityInvariantError)
    vi.restoreAllMocks()
  })

  it('refuses a snapshot whose totals disagree with the graph', () => {
    const graph = accounted()
    const snapshot = graph.normalizedIntegritySnapshot()!
    vi.spyOn(graph, 'normalizedIntegritySnapshot').mockReturnValue({
      ...snapshot,
      graphTotals: { ...snapshot.graphTotals, occurrences: snapshot.graphTotals.occurrences + 1 },
    } as never)
    expect(() => serialize(graph)).toThrow(/occurrences_retained/)
    vi.restoreAllMocks()
  })

  it('refuses a snapshot whose storage admission is not a projection', () => {
    const graph = accounted()
    const snapshot = graph.normalizedIntegritySnapshot()!
    vi.spyOn(graph, 'normalizedIntegritySnapshot').mockReturnValue({
      ...snapshot,
      storageAdmission: {
        unresolvedUnregisteredRelationCandidates: 5,
        unregisteredRelationCounts: { totally_unregistered: 5 },
      },
    } as never)
    expect(() => serialize(graph)).toThrow(/storage admission counted 5/)
    vi.restoreAllMocks()
  })

  it('refuses a snapshot carrying a malformed record', () => {
    const graph = accounted()
    const snapshot = graph.normalizedIntegritySnapshot()!
    const forged = { ...snapshot.unresolvedRecords[0], id: 'uc_short' }
    vi.spyOn(graph, 'normalizedIntegritySnapshot').mockReturnValue({
      ...snapshot,
      unresolvedRecords: [forged],
    } as never)
    expect(() => serialize(graph)).toThrow(GraphIntegrityInvariantError)
    vi.restoreAllMocks()
  })
})

describe('S3-2 — an invalid snapshot leaves the published workspace untouched', () => {
  function workspaceWith(bytes: Buffer): string {
    const dir = mkdtempSync(join(tmpdir(), 'madar-atomic-'))
    activateGraphArtifactV2InDirectory(dir, bytes)
    return dir
  }

  it('writes no artifact at all into a fresh workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-atomic-'))
    try {
      const graph = accounted()
      const snapshot = graph.normalizedIntegritySnapshot()!
      vi.spyOn(graph, 'normalizedIntegritySnapshot')
        .mockReturnValue({ ...snapshot, status: 'valid' } as never)
      // The refusal happens inside the serializer, before the activation
      // primitive is reached, so there is nothing to roll back.
      expect(() => activateGraphArtifactV2InDirectory(dir, serialize(graph)))
        .toThrow(GraphIntegrityInvariantError)
      vi.restoreAllMocks()
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a previously published artifact byte-for-byte intact', () => {
    const published = serialize(accounted())
    const dir = workspaceWith(published)
    try {
      const graph = accounted()
      const snapshot = graph.normalizedIntegritySnapshot()!
      vi.spyOn(graph, 'normalizedIntegritySnapshot').mockReturnValue({
        ...snapshot,
        graphTotals: { ...snapshot.graphTotals, facts: snapshot.graphTotals.facts + 1 },
      } as never)
      expect(() => activateGraphArtifactV2InDirectory(dir, serialize(graph))).toThrow()
      vi.restoreAllMocks()
      expect(readFileSync(join(dir, 'graph.madar')).equals(published)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves no temporary output behind', () => {
    const dir = workspaceWith(serialize(accounted()))
    try {
      const graph = accounted()
      const snapshot = graph.normalizedIntegritySnapshot()!
      vi.spyOn(graph, 'normalizedIntegritySnapshot')
        .mockReturnValue({ ...snapshot, status: 'valid' } as never)
      expect(() => activateGraphArtifactV2InDirectory(dir, serialize(graph))).toThrow()
      vi.restoreAllMocks()
      // A partially written normalized block must never survive as a staged
      // file a later run could mistake for output.
      expect(readdirSync(dir).filter((entry) => entry.includes('tmp') || entry.endsWith('.partial')))
        .toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('S3-2 — a caller cannot publish accounting the graph never produced', () => {
  it('ignores a normalized block smuggled onto a caller-supplied receipt', () => {
    // A supplied receipt is an ordinary object and may carry anything. The only
    // accounting that reaches the bytes is what this graph's snapshot projects.
    const graph = unaccounted()
    const genuine = receiptOf(accounted())
    const supplied = {
      ...(receiptOf(graph) as GraphArtifactIntegrityReceipt),
      [NORMALIZED_ACCOUNTING_ARTIFACT_KEY]: genuine.normalized_accounting,
    }
    const bytes = serializeGraphArtifactV2({ graph, ...FIXED, integrityReceipt: supplied })
    const written = parseGraphArtifactV2(bytes).integrity_receipt as Record<string, unknown>
    expect(Object.keys(written)).not.toContain(NORMALIZED_ACCOUNTING_ARTIFACT_KEY)
  })

  it('emits the graph own accounting even when the supplied receipt has none', () => {
    const graph = accounted()
    const supplied = { ...(receiptOf(graph) as GraphArtifactIntegrityReceipt) }
    delete (supplied as Record<string, unknown>)[NORMALIZED_ACCOUNTING_ARTIFACT_KEY]
    const bytes = serializeGraphArtifactV2({ graph, ...FIXED, integrityReceipt: supplied })
    const written = parseGraphArtifactV2(bytes).integrity_receipt as GraphArtifactIntegrityReceipt
    expect(written.normalized_accounting).toBeDefined()
  })
})
