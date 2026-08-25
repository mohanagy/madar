import { describe, expect, it } from 'vitest'

import {
  GraphIntegrityInvariantError,
} from '../../src/contracts/graph-integrity.js'
import {
  loadGraphArtifact,
  serializeGraphArtifactV2,
  type LoadedGraphArtifact,
} from '../../src/contracts/graph-artifact.js'
import {
  buildGraphArtifactNormalizedAccounting,
  parseGraphArtifactNormalizedAccounting,
} from '../../src/contracts/graph-artifact-normalized-accounting.js'
import { buildFromJson } from '../../src/pipeline/build.js'

/**
 * A loaded accounting block is data, not a handle into the decoded artifact.
 *
 * `parseGraphArtifactNormalizedAccounting` documented itself as returning
 * "validated, detached data" and returned the live object graph `JSON.parse`
 * had produced. Nothing was copied and nothing was frozen, so every caller
 * holding `LoadedGraphArtifact.normalizedAccounting` held a writable alias into
 * the artifact: a receipt count, a retained record or a retention object could
 * be rewritten through it, and the loaded graph would then disagree with the
 * bytes it was loaded from while still reporting itself as valid.
 *
 * The correction is a clone followed by a deep freeze, and the two halves prove
 * different things. Freezing alone would leave the caller unable to edit the
 * block but would also freeze the loader's own decoded value as a side effect
 * of parsing it. Cloning alone would sever the alias but hand back something
 * still editable. Both are asserted separately below.
 */

const FIXED = {
  repositoryRevision: 'detachment',
  generationMode: 'full',
  generatedAt: '2026-08-25T00:00:00.000Z',
} as const

function extraction(): Record<string, unknown> {
  return {
    schema_version: 2,
    directed: true,
    nodes: ['alpha', 'beta'].map((id) => ({
      id,
      label: id,
      file_type: 'code',
      source_file: `src/${id}.ts`,
      endpointIdentity: { status: 'stable', reasons: [] },
    })),
    edges: [{
      source: 'alpha',
      target: 'beta',
      relation: 'contains',
      confidence: 'EXTRACTED',
      source_file: 'src/alpha.ts',
    }],
  }
}

function graph() {
  return buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
}

const bytes = (): Buffer => serializeGraphArtifactV2({ graph: graph(), ...FIXED })

const loaded = (): LoadedGraphArtifact => loadGraphArtifact(bytes())

/** The decoded wire value, exactly as the loader would hand it to the parser. */
function decodedBlock(): Record<string, unknown> {
  const text = bytes().toString('utf8')
  const payload = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
    integrity_receipt: { normalized_accounting: Record<string, unknown> }
  }
  return payload.integrity_receipt.normalized_accounting
}

const FIELD = 'integrity_receipt.normalized_accounting'

describe('S3-D — the parsed block is detached from the decoded input', () => {
  it('does not return the object it was given', () => {
    const input = decodedBlock()
    expect(parseGraphArtifactNormalizedAccounting(input, FIELD)).not.toBe(input)
  })

  it('does not freeze the caller’s decoded value as a side effect', () => {
    // Freezing in place would be a silent contract change for the loader, which
    // owns that decoded object and is entitled to keep using it.
    const input = decodedBlock()
    parseGraphArtifactNormalizedAccounting(input, FIELD)
    expect(Object.isFrozen(input)).toBe(false)
  })

  it('ignores a mutation made to the decoded input after parsing', () => {
    const input = decodedBlock()
    const block = parseGraphArtifactNormalizedAccounting(input, FIELD)
    const before = block.receipt.emitted_candidates

    ;(input['receipt'] as Record<string, unknown>)['emitted_candidates'] = 9999

    expect(block.receipt.emitted_candidates).toBe(before)
    expect(block.receipt.emitted_candidates).not.toBe(9999)
  })

  it('does not share nested arrays with the decoded input', () => {
    const input = decodedBlock()
    const block = parseGraphArtifactNormalizedAccounting(input, FIELD)
    expect(block.unresolved_records).not.toBe(input['unresolved_records'])
    expect(block.receipt).not.toBe(input['receipt'])
  })
})

describe('S3-D — the parsed block is frozen all the way down', () => {
  it('freezes the block, the receipt and every nested counter object', () => {
    const block = loaded().normalizedAccounting!
    expect(Object.isFrozen(block)).toBe(true)
    expect(Object.isFrozen(block.receipt)).toBe(true)
    expect(Object.isFrozen(block.receipt.terminal_counts)).toBe(true)
    expect(Object.isFrozen(block.receipt.terminal_reason_counts)).toBe(true)
    expect(Object.isFrozen(block.receipt.durable_records)).toBe(true)
    expect(Object.isFrozen(block.receipt.endpoint_identity)).toBe(true)
  })

  it('freezes the record arrays and the retention objects they carry', () => {
    const block = loaded().normalizedAccounting!
    for (const records of [block.unresolved_records, block.rejected_records, block.conflict_records]) {
      expect(Object.isFrozen(records)).toBe(true)
    }
    for (const kind of ['unresolved', 'rejected', 'conflicting'] as const) {
      expect(Object.isFrozen(block.receipt.durable_records[kind])).toBe(true)
    }
  })

  it('refuses a write to a nested receipt counter', () => {
    // ESM modules are strict, so a refused write throws rather than passing
    // silently. Both the throw and the unchanged value are asserted: a test
    // that only caught the throw would still pass if the value had changed.
    const block = loaded().normalizedAccounting!
    const before = block.receipt.emitted_candidates
    expect(() => {
      (block.receipt as unknown as Record<string, unknown>)['emitted_candidates'] = 9999
    }).toThrow(TypeError)
    expect(block.receipt.emitted_candidates).toBe(before)
  })

  it('refuses a push onto a retained-record array', () => {
    const block = loaded().normalizedAccounting!
    const before = block.unresolved_records.length
    expect(() => (block.unresolved_records as unknown as unknown[]).push({} as never)).toThrow(TypeError)
    expect(block.unresolved_records).toHaveLength(before)
  })
})

describe('S3-D — the write path promises the same depth', () => {
  it('freezes a built block as deeply as a parsed one', () => {
    // Asymmetry here would mean the guarantee depended on which side of the
    // wire the caller happened to be standing on.
    const snapshot = graph().normalizedIntegritySnapshot()!
    const built = buildGraphArtifactNormalizedAccounting(snapshot)
    expect(Object.isFrozen(built)).toBe(true)
    expect(Object.isFrozen(built.receipt)).toBe(true)
    expect(Object.isFrozen(built.receipt.terminal_counts)).toBe(true)
    expect(Object.isFrozen(built.receipt.durable_records)).toBe(true)
  })
})

describe('S3-D — a held block cannot rewrite the hydrated graph', () => {
  it('leaves the graph snapshot intact when the block is attacked', () => {
    const artifact = loaded()
    const block = artifact.normalizedAccounting!
    const snapshotBefore = artifact.graph.normalizedIntegritySnapshot()!
    const emittedBefore = snapshotBefore.emittedCandidates

    expect(() => {
      (block.receipt as unknown as Record<string, unknown>)['emitted_candidates'] = 1234
    }).toThrow(TypeError)

    expect(artifact.graph.normalizedIntegritySnapshot()!.emittedCandidates).toBe(emittedBefore)
  })
})

describe('S3-D — validation still comes first', () => {
  it('rejects a malformed block with the typed invariant error, not a freeze error', () => {
    const malformed = decodedBlock()
    ;(malformed['receipt'] as Record<string, unknown>)['emitted_candidates'] = -1
    expect(() => parseGraphArtifactNormalizedAccounting(malformed, FIELD))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('rejects a non-object without attempting to clone it', () => {
    expect(() => parseGraphArtifactNormalizedAccounting(null, FIELD)).toThrow(GraphIntegrityInvariantError)
    expect(() => parseGraphArtifactNormalizedAccounting(42, FIELD)).toThrow(GraphIntegrityInvariantError)
  })
})
