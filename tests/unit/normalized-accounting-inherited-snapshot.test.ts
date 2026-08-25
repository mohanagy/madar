import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { loadGraphArtifact, serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { buildFromJson } from '../../src/pipeline/build.js'

/**
 * Inherited accounting must arrive with a snapshot, or not arrive at all.
 *
 * `inheritDegradationFrom` exists because a direction-changing copy builds a
 * fresh graph rather than going through `copy()`, so the degradation the copy
 * would have preserved has to be carried explicitly. It carried the accounting
 * field and then invalidated the snapshot, which produced a state the artifact
 * contract cannot express: accounting attached, snapshot null.
 *
 * That mattered because `serializeGraphArtifactV2` reads the SNAPSHOT. A
 * direction-changing generate therefore wrote an artifact with no
 * `normalized_accounting` block at all -- the accounting was silently dropped
 * on the way to disk -- and the resulting artifact was then refused outright by
 * strict mode, with a message about missing accounting that pointed nowhere
 * near the direction change that removed it.
 *
 * The fix finalizes a new snapshot over the TARGET, because the target is a
 * different graph: replaying under a different direction can merge endpoints,
 * so the source's totals are not the target's.
 */

const FIXED = {
  repositoryRevision: 'inherited-snapshot',
  generationMode: 'full',
  generatedAt: '2026-08-25T00:00:00.000Z',
} as const

function extraction(): Record<string, unknown> {
  return {
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
      { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
    ],
    edges: [
      { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      // Produces an unresolved candidate, so the accounting being carried is
      // real degradation rather than an empty structure.
      { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      // Produces an unregistered-relation admission, so admissions are carried too.
      { source: 'beta', target: 'alpha', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
    ],
  }
}

const source = (): KnowledgeGraph =>
  buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })

/**
 * The same shape `copyGraphWithDirection` builds: a fresh graph of the opposite
 * direction, replayed fact by fact, then handed the source's degradation.
 */
function directionChangedCopy(from: KnowledgeGraph): KnowledgeGraph {
  const copied = new KnowledgeGraph({ directed: false })
  for (const id of from.nodeIds()) copied.addNode(id, from.nodeAttributes(id) as never)
  for (const { fact, attributes } of from.factRecords()) {
    const admission = copied.addEdge(fact.source, fact.target, { ...attributes }, {
      discriminator: fact.discriminator,
      recordOccurrence: false,
    })
    if (admission.status !== 'stored') throw new Error(`replay could not admit ${fact.relation}`)
  }
  copied.inheritDegradationFrom(from)
  return copied
}

describe('S3-I — the forbidden state does not exist', () => {
  it('never leaves accounting attached with a null snapshot', () => {
    const copied = directionChangedCopy(source())
    // The invariant, stated as one assertion rather than implied by the two
    // that follow it.
    expect(copied.normalizedAccountingSummary() !== null && copied.normalizedIntegritySnapshot() === null)
      .toBe(false)
  })

  it('carries both the accounting and a finalized snapshot', () => {
    const copied = directionChangedCopy(source())
    expect(copied.normalizedAccountingSummary()).not.toBeNull()
    expect(copied.normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('carries the unregistered-relation admissions too', () => {
    const copied = directionChangedCopy(source())
    expect(copied.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBeGreaterThan(0)
  })
})

describe('S3-I — the inherited accounting reaches the artifact', () => {
  const bytesOf = (graph: KnowledgeGraph): Buffer => serializeGraphArtifactV2({ graph, ...FIXED })

  it('serializes a normalized_accounting block', () => {
    const text = bytesOf(directionChangedCopy(source())).toString('utf8')
    const payload = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
      integrity_receipt: Record<string, unknown>
    }
    expect(Object.prototype.hasOwnProperty.call(payload.integrity_receipt, 'normalized_accounting')).toBe(true)
  })

  it('loads that block back in normal mode', () => {
    const loaded = loadGraphArtifact(bytesOf(directionChangedCopy(source())))
    expect(loaded.normalizedAccounting).not.toBeNull()
    expect(loaded.graph.normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('is no longer refused for having no accounting at all', () => {
    // Strict may still refuse this artifact on its merits -- it carries real
    // degradation -- but it must not refuse it for an absence the direction
    // change introduced.
    let message = ''
    try {
      loadGraphArtifact(bytesOf(directionChangedCopy(source())), { mode: 'strict' })
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).not.toContain('requires normalized candidate accounting')
  })

  it('reports the target’s own fact total, not the source’s', () => {
    const copied = directionChangedCopy(source())
    const loaded = loadGraphArtifact(bytesOf(copied))
    expect(loaded.normalizedAccounting!.receipt.facts_retained).toBe(copied.numberOfFacts())
  })
})

describe('S3-I — inheritance stays atomic and unaliased', () => {
  it('leaves the target untouched when inheritance is refused', () => {
    const donor = source()
    const target = source()
    // The target already has accounting of its own, which is the laundering
    // case the guard refuses.
    expect(() => target.inheritDegradationFrom(donor)).toThrow()
    expect(target.normalizedAccountingSummary()).not.toBeNull()
    expect(target.normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('does not alias the source’s snapshot into the target', () => {
    const from = source()
    const copied = directionChangedCopy(from)
    // Distinct objects: the target's snapshot describes the target's totals.
    expect(copied.normalizedIntegritySnapshot()).not.toBe(from.normalizedIntegritySnapshot())
  })

  it('inheriting nothing still changes nothing', () => {
    const target = new KnowledgeGraph({ directed: true })
    target.inheritDegradationFrom(new KnowledgeGraph({ directed: true }))
    expect(target.normalizedAccountingSummary()).toBeNull()
    expect(target.normalizedIntegritySnapshot()).toBeNull()
  })
})
