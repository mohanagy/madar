import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  GraphArtifactInvariantError,
  loadGraphArtifact,
  serializeGraphArtifactV2,
  type LoadedGraphArtifact,
} from '../../src/contracts/graph-artifact.js'
import { buildFromJson } from '../../src/pipeline/build.js'

/**
 * The strict boundary, proven on actual serialized bytes rather than on
 * hand-built receipts.
 *
 * `S3-STRICT-WARN-01` was reproducible only through real artifacts: the policy
 * owner and the loader were each individually defensible, and the false
 * qualification appeared where they met. So every artifact here is built by the
 * real pipeline and serialized by the real writer, and every verdict is taken
 * from the public loader API.
 *
 * Nothing is hand-edited. Each warning family is provoked by giving the
 * extraction an input that genuinely produces it, so the status, the reasons
 * and the counters all derive consistently from one another. Editing a status
 * field would only prove the validators notice an inconsistency -- which is a
 * different test, and one the tamper matrix already owns.
 */

const FIXED = {
  repositoryRevision: 'strict-warning-matrix',
  generationMode: 'full',
  generatedAt: '2026-08-24T00:00:00.000Z',
} as const

const MODES = ['strict', 'qualification'] as const

/** Certified stable: no degradation reason, so it contributes no warning. */
const STABLE = { status: 'stable', reasons: [] as readonly string[] } as const
/** Audited as context-dependent: the identity is derived from a source location. */
const CONTEXT_BOUND = { status: 'context_bound', reasons: ['source_location_derived'] } as const
/** Not audited at all, which the identity policy reports rather than assumes. */
const UNKNOWN = { status: 'unknown', reasons: ['identity_policy_not_audited'] } as const

/**
 * `contains` is an endpoint-only discriminator policy: it names no behaviour
 * data, so a producer cannot fail to supply any and no warning is retained.
 */
const COMPLETE_RELATION = 'contains'
/**
 * `calls` is a partial policy: the registry names behaviour data this producer
 * does not supply, so the retained fact carries `partial_discriminator`.
 */
const PARTIAL_RELATION = 'calls'

interface Fixture {
  readonly schemaVersion: 1 | 2
  readonly identity: typeof STABLE | typeof CONTEXT_BOUND | typeof UNKNOWN | null
  readonly relation: string
}

function extraction({ schemaVersion, identity, relation }: Fixture): Record<string, unknown> {
  // Schema 1 classifies every endpoint as legacy through the compatibility
  // path; schema 2 carries the extractor's own qualification.
  const node = (id: string): Record<string, unknown> => (schemaVersion === 1
    ? { id, label: id, file_type: 'code', source_file: `src/${id}.ts` }
    : { id, label: id, file_type: 'code', source_file: `src/${id}.ts`, endpointIdentity: identity })
  return {
    schema_version: schemaVersion,
    directed: true,
    nodes: [node('alpha'), node('beta')],
    edges: [{
      source: 'alpha',
      target: 'beta',
      relation,
      confidence: 'EXTRACTED',
      source_file: 'src/alpha.ts',
    }],
  }
}

function bytesFor(fixture: Fixture): Buffer {
  const graph = buildFromJson(extraction(fixture), {
    directed: true,
    accounting: 'normalized_extraction_boundary',
  })
  return serializeGraphArtifactV2({ graph, ...FIXED })
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A fully qualified corpus: every candidate retained, every fact certified. */
const VALID: Fixture = { schemaVersion: 2, identity: STABLE, relation: COMPLETE_RELATION }

const WARNING_FAMILIES = [
  {
    reason: 'partial_discriminator_retained',
    fixture: { schemaVersion: 2, identity: STABLE, relation: PARTIAL_RELATION } as Fixture,
  },
  {
    reason: 'context_bound_endpoint_identity',
    fixture: { schemaVersion: 2, identity: CONTEXT_BOUND, relation: COMPLETE_RELATION } as Fixture,
  },
  {
    reason: 'unknown_endpoint_identity',
    fixture: { schemaVersion: 2, identity: UNKNOWN, relation: COMPLETE_RELATION } as Fixture,
  },
  {
    reason: 'legacy_endpoint_identity',
    fixture: { schemaVersion: 1, identity: null, relation: COMPLETE_RELATION } as Fixture,
  },
] as const

describe('S3-W — each warning family is a real artifact, not an edited one', () => {
  for (const { reason, fixture } of WARNING_FAMILIES) {
    it(`${reason} derives consistently from a real extraction`, () => {
      const loaded = loadGraphArtifact(bytesFor(fixture))
      const receipt = loaded.normalizedAccounting!.receipt
      expect(receipt.status).toBe('valid_with_warnings')
      expect(receipt.reasons).toContain(reason)
      // No candidate was lost: this is a warning about retained facts, not a
      // degradation. If candidates had been lost the status would be
      // `degraded` and the control would be testing the wrong boundary.
      expect(receipt.terminal_counts.unresolved).toBe(0)
      expect(receipt.terminal_counts.rejected).toBe(0)
      expect(receipt.terminal_counts.conflicting).toBe(0)
      expect(receipt.terminal_counts.invariant_failed).toBe(0)
    })
  }

  it('produces four distinct artifacts', () => {
    // Four identical files would make the matrix one test repeated four times.
    const digests = WARNING_FAMILIES.map(({ fixture }) => digest(bytesFor(fixture)))
    expect(new Set(digests).size).toBe(WARNING_FAMILIES.length)
    expect(digests).not.toContain(digest(bytesFor(VALID)))
  })
})

describe('S3-W — normal mode stays truthful for every warning family', () => {
  for (const { reason, fixture } of WARNING_FAMILIES) {
    it(`loads ${reason} and preserves its exact reasons and counters`, () => {
      const bytes = bytesFor(fixture)
      const loaded = loadGraphArtifact(bytes)
      const receipt = loaded.normalizedAccounting!.receipt
      const snapshot = loaded.graph.normalizedIntegritySnapshot()

      expect(loaded.format).toBe('v2')
      expect(snapshot).not.toBeNull()
      expect(snapshot!.status).toBe('valid_with_warnings')
      expect(snapshot!.reasons).toEqual(receipt.reasons)
      expect(snapshot!.terminalReasonCounts).toEqual(receipt.terminal_reason_counts)
      expect(snapshot!.emittedCandidates).toBe(receipt.emitted_candidates)
      expect(loaded.graph.numberOfFacts()).toBe(receipt.facts_retained)
    })
  }
})

describe('S3-W — strict and qualification fail closed on every warning family', () => {
  for (const { reason, fixture } of WARNING_FAMILIES) {
    for (const mode of MODES) {
      it(`${mode} refuses ${reason}`, () => {
        expect(() => loadGraphArtifact(bytesFor(fixture), { mode }))
          .toThrow(/strict qualification requires valid/)
      })

      it(`${mode} refuses ${reason} with a typed artifact invariant`, () => {
        let thrown: unknown
        try {
          loadGraphArtifact(bytesFor(fixture), { mode })
        } catch (error) {
          thrown = error
        }
        // A raw receipt error or a TypeError escaping here would mean the
        // loader leaked an internal failure instead of refusing an artifact.
        expect(thrown).toBeInstanceOf(GraphArtifactInvariantError)
        expect(thrown).not.toBeInstanceOf(TypeError)
        expect(String(thrown)).toContain(mode)
        expect(String(thrown)).toContain('valid_with_warnings')
      })

      it(`${mode} exposes no artifact when it refuses ${reason}`, () => {
        let loaded: LoadedGraphArtifact | undefined
        try {
          loaded = loadGraphArtifact(bytesFor(fixture), { mode })
        } catch {
          loaded = undefined
        }
        // No partially attached graph reaches the caller: a refusal must not
        // hand back something it then has to remember to distrust.
        expect(loaded).toBeUndefined()
      })
    }
  }
})

describe('S3-W — the retained partial discriminator is fatal on its own', () => {
  const partial = WARNING_FAMILIES[0].fixture

  it('retains a partial discriminator and discloses it', () => {
    const receipt = loadGraphArtifact(bytesFor(partial)).normalizedAccounting!.receipt
    expect(receipt.terminal_reason_counts.partial_discriminator).toBeGreaterThan(0)
    expect(receipt.reasons).toContain('partial_discriminator_retained')
  })

  it('carries no qualification exception to appeal to', () => {
    // The strict contract makes a partial required discriminator fatal unless
    // an explicit qualification authority declares an allowed boundary. This
    // artifact contract has no field that could carry one, and the control
    // states that rather than leaving it implied.
    const block = loadGraphArtifact(bytesFor(partial)).normalizedAccounting!
    const serialized = JSON.stringify(block)
    expect(serialized).not.toContain('exception')
    expect(serialized).not.toContain('waiver')
    expect(serialized).not.toContain('allowed_boundary')
    expect(Object.keys(block.reserved)).toEqual([])
  })

  it('is refused by strict even though every candidate was retained', () => {
    const receipt = loadGraphArtifact(bytesFor(partial)).normalizedAccounting!.receipt
    expect(receipt.terminal_counts.retained_new_fact).toBeGreaterThan(0)
    expect(receipt.emitted_candidates).toBe(receipt.terminal_counts.retained_new_fact)
    for (const mode of MODES) {
      expect(() => loadGraphArtifact(bytesFor(partial), { mode })).toThrow(GraphArtifactInvariantError)
    }
  })
})

describe('S3-W — a fully qualified artifact still passes', () => {
  it('reaches exactly valid', () => {
    // Without this the whole matrix would be satisfied by a gate that refused
    // everything, which would prove nothing at all.
    const receipt = loadGraphArtifact(bytesFor(VALID)).normalizedAccounting!.receipt
    expect(receipt.status).toBe('valid')
    expect(receipt.terminal_reason_counts).toEqual({})
    expect(receipt.reasons).toEqual(['full_emission_accounting_not_available'])
  })

  for (const mode of MODES) {
    it(`${mode} accepts it`, () => {
      const loaded = loadGraphArtifact(bytesFor(VALID), { mode })
      expect(loaded.format).toBe('v2')
      expect(loaded.graph.normalizedIntegritySnapshot()!.status).toBe('valid')
    })
  }

  it('loads identically in normal mode', () => {
    const bytes = bytesFor(VALID)
    expect(loadGraphArtifact(bytes, { mode: 'strict' }).graph.numberOfFacts())
      .toBe(loadGraphArtifact(bytes).graph.numberOfFacts())
  })
})

describe('S3-W — generation never records a strict verdict', () => {
  it('writes not_run for every artifact in this matrix', () => {
    for (const fixture of [VALID, ...WARNING_FAMILIES.map((family) => family.fixture)]) {
      const receipt = loadGraphArtifact(bytesFor(fixture)).normalizedAccounting!.receipt
      expect(receipt.strict_mode_result).toBe('not_run')
    }
  })

  it('writes not_run even for the artifact strict accepts', () => {
    // Eligibility is decided on load against the bytes as they stand. Baking a
    // verdict in would make this very policy change require rewriting
    // artifacts that did not themselves change -- and the four warning
    // artifacts above are byte-identical before and after the correction.
    expect(loadGraphArtifact(bytesFor(VALID)).normalizedAccounting!.receipt.strict_mode_result)
      .toBe('not_run')
  })

  it('omits accounting entirely for a graph no normalized build produced', () => {
    const bare = serializeGraphArtifactV2({ graph: new KnowledgeGraph({ directed: true }), ...FIXED })
    expect(loadGraphArtifact(bare).normalizedAccounting).toBeNull()
    for (const mode of MODES) {
      expect(() => loadGraphArtifact(bare, { mode }))
        .toThrow(/requires normalized candidate accounting/)
    }
  })
})
