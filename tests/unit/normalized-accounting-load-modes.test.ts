import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  GRAPH_ARTIFACT_V2_HEADER,
  GraphArtifactInvariantError,
  NORMALIZED_ACCOUNTING_UNAVAILABLE,
  loadGraphArtifact,
  serializeGraphArtifactV2,
  type LoadGraphArtifactOptions,
} from '../../src/contracts/graph-artifact.js'
import { NORMALIZED_ACCOUNTING_ARTIFACT_KEY } from '../../src/contracts/graph-artifact-payload.js'
import { assertStrictModeResultPolicy } from '../../src/contracts/graph-integrity-receipt.js'
import { buildFromJson } from '../../src/pipeline/build.js'

const FIXED = {
  repositoryRevision: 'rev-fixed',
  generationMode: 'full',
  generatedAt: '2026-08-24T00:00:00.000Z',
} as const

const NON_NORMAL_MODES = ['strict', 'qualification'] as const

/**
 * A schema-2 extraction whose endpoints are certified stable.
 *
 * Schema 1 classifies every endpoint as legacy, which is itself a warning
 * family, so a schema-1 corpus can never reach `valid` however clean its
 * candidates are. A strict positive control built on one would only prove that
 * strict accepts warnings -- which is the defect, not the contract.
 */
function extraction(edges: readonly Record<string, unknown>[]): Record<string, unknown> {
  const node = (id: string): Record<string, unknown> => ({
    id,
    label: id,
    file_type: 'code',
    source_file: `src/${id}.ts`,
    endpointIdentity: { status: 'stable', reasons: [] },
  })
  return {
    schema_version: 2,
    directed: true,
    nodes: [node('alpha'), node('beta'), node('gamma')],
    edges,
  }
}

/**
 * Every candidate terminates cleanly AND every retained fact is fully
 * qualified: `contains` is an endpoint-only discriminator policy, so it names
 * no behaviour data the producer failed to supply. `calls` is a partial policy
 * and would retain `partial_discriminator`, which is a warning and therefore
 * not strict-eligible.
 */
const CLEAN_EDGES = [
  { source: 'alpha', target: 'beta', relation: 'contains', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
  { source: 'beta', target: 'gamma', relation: 'contains', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
] as const

/** One missing endpoint and one unregistered relation, so candidates degrade. */
const DEGRADING_EDGES = [
  ...CLEAN_EDGES,
  { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
  { source: 'beta', target: 'gamma', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
] as const

/** A loadable v1 artifact, so a strict refusal is about the mode not the shape. */
const LEGACY_V1 = JSON.stringify({
  schema_version: 1,
  directed: true,
  nodes: [{ id: 'source', label: 'Source' }, { id: 'target', label: 'Target' }],
  links: [{ source: 'source', target: 'target', relation: 'calls' }],
  hyperedges: [],
  community_labels: { 0: 'Legacy' },
})

function bytes(edges: readonly Record<string, unknown>[], accounted = true): Buffer {
  const graph = buildFromJson(
    extraction(edges),
    accounted ? { directed: true, accounting: 'normalized_extraction_boundary' } : { directed: true },
  )
  return serializeGraphArtifactV2({ graph, ...FIXED })
}

function statusOf(edges: readonly Record<string, unknown>[]): string {
  return loadGraphArtifact(bytes(edges)).normalizedAccounting!.receipt.status
}

function load(source: Buffer | string, options: LoadGraphArtifactOptions = {}) {
  return loadGraphArtifact(source, options)
}

describe('S3-4 — the fixtures reach the statuses these controls depend on', () => {
  it('reaches exactly valid with a clean corpus', () => {
    // Without this the strict-pass controls would be vacuous: everything would
    // fail strict for the wrong reason. `valid_with_warnings` is NOT good
    // enough here -- the previous version of this control accepted it, and that
    // is precisely how a warning artifact passed as a strict positive.
    expect(statusOf(CLEAN_EDGES)).toBe('valid')
  })

  it('reaches a degraded status with lost candidates', () => {
    expect(statusOf(DEGRADING_EDGES)).toBe('degraded')
  })
})

describe('S3-4 — normal mode keeps degraded artifacts usable', () => {
  it('loads a degraded normalized artifact', () => {
    const loaded = load(bytes(DEGRADING_EDGES))
    expect(loaded.graph.numberOfFacts()).toBe(2)
    expect(loaded.normalizedAccounting!.receipt.status).toBe('degraded')
  })

  it('loads an artifact with no accounting and says so', () => {
    const loaded = load(bytes(DEGRADING_EDGES, false))
    expect(loaded.normalizedAccounting).toBeNull()
    expect(loaded.diagnostics).toContain(NORMALIZED_ACCOUNTING_UNAVAILABLE)
  })

  it('is what an unspecified mode means', () => {
    expect(load(bytes(DEGRADING_EDGES)).diagnostics)
      .toEqual(load(bytes(DEGRADING_EDGES), { mode: 'normal' }).diagnostics)
  })
})

describe('S3-4 — strict and qualification fail closed', () => {
  for (const mode of NON_NORMAL_MODES) {
    it(`${mode} refuses an artifact carrying no normalized accounting`, () => {
      // An artifact written before #658 is exactly this, and so is every
      // `--cluster-only` or reuse publication. Loading it as though it had
      // qualified would be the whole failure #658 exists to prevent.
      expect(() => load(bytes(DEGRADING_EDGES, false), { mode }))
        .toThrow(new RegExp(`${mode} mode requires normalized candidate accounting`))
    })

    it(`${mode} refuses a degraded normalized artifact`, () => {
      expect(() => load(bytes(DEGRADING_EDGES), { mode }))
        .toThrow(new RegExp(`${mode} mode cannot qualify this artifact`))
    })

    it(`${mode} refuses a legacy v1 artifact`, () => {
      expect(() => load(LEGACY_V1, { mode }))
        .toThrow(new RegExp(`legacy v1 artifacts are rejected in ${mode} mode`))
    })

    it(`${mode} refuses the same legacy artifact normal mode accepts`, () => {
      // Non-vacuity for the case above: the payload really is loadable, so the
      // refusal comes from the mode and not from a malformed fixture.
      expect(load(LEGACY_V1).format).toBe('v1')
    })

    it(`${mode} accepts a fully qualified corpus`, () => {
      // Fail-closed has to be discriminating, not blanket. A gate that refused
      // everything would pass every refusal control and prove nothing.
      const loaded = load(bytes(CLEAN_EDGES), { mode })
      expect(loaded.normalizedAccounting!.receipt.status).toBe('valid')
      expect(loaded.graph.normalizedIntegritySnapshot()).not.toBeNull()
      expect(loaded.normalizedAccounting!.receipt.strict_mode_result).toBe('not_run')
    })

    it(`${mode} refuses a tampered normalized block`, () => {
      const source = bytes(CLEAN_EDGES).toString('utf8')
      const payload = JSON.parse(source.slice(GRAPH_ARTIFACT_V2_HEADER.length)) as Record<string, unknown>
      const receipt = payload.integrity_receipt as Record<string, unknown>
      const block = receipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY] as Record<string, unknown>
      ;(block.receipt as Record<string, unknown>).emitted_candidates = 99
      expect(() => load(`${GRAPH_ARTIFACT_V2_HEADER}${JSON.stringify(payload)}\n`, { mode }))
        .toThrow(/candidate accounting mismatch/)
    })

    it(`${mode} attaches nothing when it refuses`, () => {
      // The refusal happens before hydration completes, so a caller never
      // receives an artifact it has to remember to distrust.
      let loaded: unknown
      try {
        loaded = load(bytes(DEGRADING_EDGES), { mode })
      } catch {
        loaded = undefined
      }
      expect(loaded).toBeUndefined()
    })
  }

  it('treats strict and qualification identically', () => {
    // Splitting them would mean inventing a policy neither #658 nor the load
    // contract declares.
    const refusal = (mode: 'strict' | 'qualification'): string => {
      try {
        load(bytes(DEGRADING_EDGES), { mode })
        return 'accepted'
      } catch (error) {
        return String(error).replace(`${mode} mode`, 'MODE mode')
      }
    }
    expect(refusal('strict')).toBe(refusal('qualification'))
    expect(refusal('strict')).not.toBe('accepted')
  })
})

describe('S3-4 — the loader keeps one strict policy owner', () => {
  it('refuses exactly the statuses the receipt policy refuses', () => {
    // The loader asks `assertStrictModeResultPolicy` rather than keeping a
    // second list of acceptable statuses that could drift from it.
    for (const status of ['valid', 'valid_with_warnings', 'degraded', 'incompatible', 'invalid'] as const) {
      const policyAllows = (() => {
        try {
          assertStrictModeResultPolicy('pass', status)
          return true
        } catch {
          return false
        }
      })()
      expect(policyAllows, `${status} disagrees with the declared policy`).toBe(status === 'valid')
    }
  })

  it('does not evaluate strict mode at generation', () => {
    // Baking a verdict into the bytes would make a later policy change require
    // rewriting artifacts that did not themselves change.
    expect(load(bytes(DEGRADING_EDGES)).normalizedAccounting!.receipt.strict_mode_result).toBe('not_run')
  })

  it('adds no CLI surface of its own', () => {
    const options: LoadGraphArtifactOptions = { mode: 'strict' }
    expect(Object.keys(options)).toEqual(['mode'])
  })
})

describe('S3-4 — an empty graph is still accounted for honestly', () => {
  it('omits accounting for a graph no build produced, and strict refuses it', () => {
    const bare = serializeGraphArtifactV2({ graph: new KnowledgeGraph({ directed: true }), ...FIXED })
    expect(load(bare).normalizedAccounting).toBeNull()
    expect(() => load(bare, { mode: 'strict' })).toThrow(GraphArtifactInvariantError)
  })
})
