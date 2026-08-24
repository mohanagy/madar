import { describe, expect, it } from 'vitest'

import { serializeCanonicalJson } from '../../src/contracts/canonical-json.js'
import { KnowledgeGraph, NormalizedAccountingAlreadyAttachedError } from '../../src/contracts/graph.js'
import {
  GRAPH_ARTIFACT_V2_HEADER,
  GraphArtifactInvariantError,
  NORMALIZED_ACCOUNTING_UNAVAILABLE,
  loadGraphArtifact,
  serializeGraphArtifactV2,
  type GraphArtifactIntegrityReceipt,
} from '../../src/contracts/graph-artifact.js'
import { NORMALIZED_ACCOUNTING_ARTIFACT_KEY } from '../../src/contracts/graph-artifact-payload.js'
import { GraphIntegrityInvariantError } from '../../src/contracts/graph-integrity.js'
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

const FIXED = {
  repositoryRevision: 'rev-fixed',
  generationMode: 'full',
  generatedAt: '2026-08-24T00:00:00.000Z',
} as const

function accounted(): KnowledgeGraph {
  return buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
}

function unaccounted(): KnowledgeGraph {
  return buildFromJson(extraction(), { directed: true })
}

function bytesOf(graph: KnowledgeGraph): Buffer {
  return serializeGraphArtifactV2({ graph, ...FIXED })
}

/** Rewrites the decoded payload and reframes it as artifact bytes. */
function reframe(bytes: Buffer, edit: (payload: Record<string, unknown>) => void): string {
  const payload = JSON.parse(bytes.toString('utf8').slice(GRAPH_ARTIFACT_V2_HEADER.length)) as Record<string, unknown>
  edit(payload)
  return `${GRAPH_ARTIFACT_V2_HEADER}${JSON.stringify(payload)}\n`
}

/** Rewrites only the normalized block. */
function tamper(edit: (block: Record<string, unknown>) => void): string {
  return reframe(bytesOf(accounted()), (payload) => {
    const receipt = payload.integrity_receipt as Record<string, unknown>
    edit(receipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY] as Record<string, unknown>)
  })
}

describe('S3-3 — normalized state round-trips through actual bytes', () => {
  it('attaches an equal snapshot to the loaded graph', () => {
    const original = accounted()
    const loaded = loadGraphArtifact(bytesOf(original))
    const before = original.normalizedIntegritySnapshot()!
    const after = loaded.graph.normalizedIntegritySnapshot()!
    expect(serializeCanonicalJson(after as never, { arraySemantics: 'ordered' }))
      .toBe(serializeCanonicalJson(before as never, { arraySemantics: 'ordered' }))
  })

  it('round-trips every durable record and scope failure', () => {
    const original = accounted()
    const loaded = loadGraphArtifact(bytesOf(original))
    const before = original.normalizedIntegritySnapshot()!
    const after = loaded.graph.normalizedIntegritySnapshot()!
    expect(after.unresolvedRecords).toEqual(before.unresolvedRecords)
    expect(after.rejectedRecords).toEqual(before.rejectedRecords)
    expect(after.conflictRecords).toEqual(before.conflictRecords)
    expect(after.scopeFailures).toEqual(before.scopeFailures)
    expect(after.scopeFailureRetention).toEqual(before.scopeFailureRetention)
    expect(after.recordRetention).toEqual(before.recordRetention)
  })

  it('re-serializes to the same bytes', () => {
    // The strongest statement of round-trip fidelity: nothing was dropped,
    // reordered or silently defaulted anywhere in the cycle.
    const bytes = bytesOf(accounted())
    const reloaded = loadGraphArtifact(bytes).graph
    expect(bytesOf(reloaded).equals(bytes)).toBe(true)
  })

  it('exposes the accounting on the load result', () => {
    const loaded = loadGraphArtifact(bytesOf(accounted()))
    expect(loaded.normalizedAccounting).not.toBeNull()
    expect(loaded.normalizedAccounting!.receipt.status)
      .toBe(loaded.graph.normalizedIntegritySnapshot()!.status)
  })

  it('keeps the storage receipt degraded and storage-only', () => {
    const loaded = loadGraphArtifact(bytesOf(accounted()))
    expect(loaded.receipt.accounting_scope).toBe('storage_only')
    expect(loaded.receipt.status).toBe('degraded')
  })

  it('reports no accounting-unavailable diagnostic when accounting is present', () => {
    expect(loadGraphArtifact(bytesOf(accounted())).diagnostics)
      .not.toContain(NORMALIZED_ACCOUNTING_UNAVAILABLE)
  })
})

describe('S3-3 — an artifact without accounting loads as storage-only', () => {
  it('leaves the normalized snapshot null', () => {
    const loaded = loadGraphArtifact(bytesOf(unaccounted()))
    expect(loaded.graph.normalizedIntegritySnapshot()).toBeNull()
    expect(loaded.graph.normalizedAccountingSummary()).toBeNull()
    expect(loaded.normalizedAccounting).toBeNull()
  })

  it('says so in the diagnostics rather than reporting zeros', () => {
    expect(loadGraphArtifact(bytesOf(unaccounted())).diagnostics)
      .toContain(NORMALIZED_ACCOUNTING_UNAVAILABLE)
  })

  it('still loads the graph in full', () => {
    const original = unaccounted()
    const loaded = loadGraphArtifact(bytesOf(original)).graph
    expect(loaded.numberOfFacts()).toBe(original.numberOfFacts())
    expect(loaded.numberOfOccurrences()).toBe(original.numberOfOccurrences())
    expect(loaded.numberOfEndpointPairs()).toBe(original.numberOfEndpointPairs())
  })
})

describe('S3-3 — the loader never fabricates accounting', () => {
  it('performs no second fact or occurrence walk for the attachment', () => {
    // The load already walks facts once to re-derive the storage receipt.
    // Attaching accounting must not add another.
    const withAccounting = countLoadWalks(bytesOf(accounted()))
    const withoutAccounting = countLoadWalks(bytesOf(unaccounted()))
    expect(withAccounting).toBe(withoutAccounting)
  })

  function countLoadWalks(bytes: Buffer): number {
    let walks = 0
    const original = KnowledgeGraph.prototype.factRecords
    KnowledgeGraph.prototype.factRecords = function counted(this: KnowledgeGraph) {
      walks += 1
      return original.call(this)
    }
    try {
      loadGraphArtifact(bytes)
    } finally {
      KnowledgeGraph.prototype.factRecords = original
    }
    return walks
  }

  it('refuses to let a caller attach unverified accounting twice', () => {
    const loaded = loadGraphArtifact(bytesOf(accounted())).graph
    expect(() => loaded.attachNormalizedAccounting(loaded.normalizedAccountingSummary()!))
      .toThrow(NormalizedAccountingAlreadyAttachedError)
  })

  it('keeps verified hydration unreachable without the loader token', () => {
    const graph = accounted()
    expect(() => graph.hydrateNormalizedAccounting(
      Symbol('forged'),
      graph.normalizedAccountingSummary()!,
      graph.storageAdmissionSummary(),
    )).toThrow(/reserved for the artifact loader/)
  })

  it('leaves both accounting and snapshot null when attachment fails', () => {
    const graph = new KnowledgeGraph({ directed: true })
    const donor = accounted()
    const corrupt = {
      ...donor.normalizedAccountingSummary()!,
      unresolvedRecords: [{ ...donor.normalizedAccountingSummary()!.unresolvedRecords[0]!, id: 'uc_short' }],
    }
    expect(() => graph.attachNormalizedAccounting(corrupt as never)).toThrow(GraphIntegrityInvariantError)
    // Half-attached is a state no successful call can produce, and a later
    // reader could not tell it from a legitimate one.
    expect(graph.normalizedAccountingSummary()).toBeNull()
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })
})

describe('S3-3 — a tampered normalized block never becomes graph state', () => {
  const cases: readonly (readonly [string, () => string, RegExp])[] = [
    ['an unknown normalized key', () => tamper((block) => { block.surprise = true }), /unknown field/],
    ['a missing required key', () => tamper((block) => { delete block.scope_failures }), /missing required field/],
    ['a wrong receipt version', () => tamper((block) => {
      (block.receipt as Record<string, unknown>).receipt_version = 9
    }), /unsupported receipt_version/],
    ['a wrong reason vocabulary version', () => tamper((block) => {
      (block.receipt as Record<string, unknown>).reason_vocabulary_version = 9
    }), /unsupported reason_vocabulary_version/],
    ['a wrong accounting scope', () => tamper((block) => {
      (block.receipt as Record<string, unknown>).accounting_scope = 'storage_only'
    }), /accounting_scope must be/],
    ['a candidate equation that does not balance', () => tamper((block) => {
      (block.receipt as Record<string, unknown>).emitted_candidates = 99
    }), /candidate accounting mismatch/],
    ['a forged valid status', () => tamper((block) => {
      (block.receipt as Record<string, unknown>).status = 'valid'
    }), /disagrees with its own counters/],
    ['reasons that do not match the receipt', () => tamper((block) => {
      (block.receipt as Record<string, unknown>).reasons = ['full_emission_accounting_not_available']
    }), /disagree with the receipt they describe/],
    ['a record array that disagrees with its retention', () => tamper((block) => {
      block.unresolved_records = []
    }), /claims 1 retained/],
    ['a record in the wrong array', () => tamper((block) => {
      block.rejected_records = [(block.unresolved_records as unknown[])[0]]
    }), /unresolved record in the rejected array/],
    ['a duplicate record id', () => tamper((block) => {
      const records = block.unresolved_records as unknown[]
      block.unresolved_records = [records[0], records[0]]
    }), /duplicate entry|claims 1 retained/],
    ['a non-canonical record identity', () => tamper((block) => {
      ((block.unresolved_records as Record<string, unknown>[])[0] as Record<string, unknown>).id = 'uc_short'
    }), /full lowercase SHA-256/],
    ['an unsafe record payload', () => tamper((block) => {
      ((block.unresolved_records as Record<string, unknown>[])[0] as Record<string, unknown>).source
        = '/Users/someone/private/src/alpha.ts'
    }), /not share-safe/],
    ['a scope-failure retention that does not close', () => tamper((block) => {
      block.scope_failure_retention = { retained: 3, total: 3, omitted: 0, truncated: false }
    }), /claims 3 retained/],
    ['a non-empty reserved block', () => tamper((block) => { block.reserved = { later: true } }), /reserved and must be empty/],
  ]

  for (const [name, produce, message] of cases) {
    it(`refuses ${name}`, () => {
      expect(() => loadGraphArtifact(produce())).toThrow(message)
    })

    it(`refuses ${name} with a typed invariant`, () => {
      let thrown: unknown
      try {
        loadGraphArtifact(produce())
      } catch (error) {
        thrown = error
      }
      // A raw TypeError from a property read is indistinguishable from a bug in
      // the validator, so it cannot be evidence that the data was bad.
      expect(
        thrown instanceof GraphIntegrityInvariantError || thrown instanceof GraphArtifactInvariantError,
        `${name} threw ${String(thrown)}`,
      ).toBe(true)
      expect(thrown).not.toBeInstanceOf(TypeError)
    })
  }

  it('refuses graph totals that disagree with the facts in the same artifact', () => {
    const bytes = reframe(bytesOf(accounted()), (payload) => {
      const receipt = payload.integrity_receipt as Record<string, unknown>
      const block = receipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY] as Record<string, unknown>
      const inner = block.receipt as Record<string, unknown>
      inner.occurrences_retained = (inner.occurrences_retained as number) + 1
    })
    expect(() => loadGraphArtifact(bytes)).toThrow(/occurrences_retained is 3 but the graph holds 2/)
  })

  it('refuses an endpoint matrix that disagrees with the storage receipt', () => {
    const bytes = reframe(bytesOf(accounted()), (payload) => {
      const receipt = payload.integrity_receipt as Record<string, unknown>
      const block = receipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY] as Record<string, unknown>
      const identity = (block.receipt as Record<string, unknown>).endpoint_identity as Record<string, unknown>
      const matrix = identity.fact_pair_counts as Record<string, Record<string, number>>
      matrix.legacy!.legacy = 0
      matrix.stable!.stable = 2
    })
    expect(() => loadGraphArtifact(bytes)).toThrow(/disagrees with the storage receipt at/)
  })

  it('refuses an endpoint reason count that disagrees with the storage receipt', () => {
    const bytes = reframe(bytesOf(accounted()), (payload) => {
      const receipt = payload.integrity_receipt as Record<string, unknown>
      const block = receipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY] as Record<string, unknown>
      const identity = (block.receipt as Record<string, unknown>).endpoint_identity as Record<string, unknown>
      identity.reason_fact_counts = { legacy_identity_policy: 1 }
    })
    expect(() => loadGraphArtifact(bytes)).toThrow(/endpoint reason count for "legacy_identity_policy"/)
  })

  it('refuses storage admission that is added rather than projected', () => {
    const bytes = reframe(bytesOf(accounted()), (payload) => {
      const receipt = payload.integrity_receipt as Record<string, unknown>
      const block = receipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY] as Record<string, unknown>
      const inner = block.receipt as Record<string, unknown>
      const reasons = inner.terminal_reason_counts as Record<string, number>
      delete reasons.unsupported_relation
      inner.unsupported_relations = 0
    })
    expect(() => loadGraphArtifact(bytes)).toThrow(/storage admission counted 1/)
  })

  it('leaves nothing attached when the artifact is refused', () => {
    // A refusal throws out of the whole load, so no partially accounted graph
    // is ever returned. The control states it rather than assuming it.
    expect(() => loadGraphArtifact(tamper((block) => {
      (block.receipt as Record<string, unknown>).status = 'valid'
    }))).toThrow()
  })
})

describe('S3-3 — a loaded graph reports the degradation its artifact records', () => {
  it('restores the storage-boundary admissions', () => {
    // Hydration never reaches `addEdge`, so nothing on the load path re-counts
    // the refusals. Reporting zero would make the graph look cleaner than its
    // own receipt says it is.
    const original = accounted()
    const loaded = loadGraphArtifact(bytesOf(original)).graph
    expect(loaded.storageAdmissionSummary()).toEqual(original.storageAdmissionSummary())
    expect(loaded.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(1)
  })

  it('survives a publish, load, republish, load cycle', () => {
    // The cycle a `--update` run performs. Before the admissions were restored,
    // the republished artifact carried a storage admission of zero beside a
    // normalized receipt that counted one unsupported relation, and the next
    // load refused the artifact this very code had just written.
    const first = bytesOf(accounted())
    const second = bytesOf(loadGraphArtifact(first).graph)
    expect(second.equals(first)).toBe(true)
    const third = loadGraphArtifact(second)
    expect(third.graph.normalizedIntegritySnapshot()).not.toBeNull()
    expect(bytesOf(third.graph).equals(first)).toBe(true)
  })

  it('does not accumulate admissions across repeated loads', () => {
    // Restoration is a copy, not an addition. Two loads of one artifact are two
    // independent graphs, each reporting exactly what the bytes record.
    const bytes = bytesOf(accounted())
    for (const loaded of [loadGraphArtifact(bytes), loadGraphArtifact(bytes)]) {
      expect(loaded.graph.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(1)
    }
  })
})

describe('S3-3 — the classifier refuses what the parser refuses', () => {
  it('rejects a structurally malformed block at both layers', () => {
    const bytes = tamper((block) => { delete block.receipt })
    expect(() => loadGraphArtifact(bytes)).toThrow(/missing required field "receipt"/)
  })

  it('accepts a receipt whose optional key is simply absent', () => {
    const bytes = reframe(bytesOf(accounted()), (payload) => {
      const receipt = payload.integrity_receipt as Record<string, unknown>
      delete receipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY]
    })
    const loaded = loadGraphArtifact(bytes)
    expect(loaded.normalizedAccounting).toBeNull()
    expect(loaded.graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('refuses a present-but-null block rather than treating it as absent', () => {
    const bytes = reframe(bytesOf(accounted()), (payload) => {
      const receipt = payload.integrity_receipt as Record<string, unknown>
      receipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY] = null
    })
    expect(() => loadGraphArtifact(bytes)).toThrow(/must be an object/)
  })
})

describe('S3-3 — the parsed receipt keeps its storage meaning', () => {
  it('carries the normalized block beside the storage fields', () => {
    const receipt = loadGraphArtifact(bytesOf(accounted())).receipt as GraphArtifactIntegrityReceipt
    expect(receipt.normalized_accounting).toBeDefined()
    expect(receipt.storage_admission.unresolved_unregistered_relation_candidates).toBe(1)
    expect(receipt.reserved).toEqual({})
  })
})
