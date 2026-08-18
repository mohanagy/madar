import { describe, expect, it } from 'vitest'

import {
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  classifyLegacyArtifactBytes,
  loadGraphArtifact,
} from '../../src/contracts/graph-artifact.js'

/**
 * The bounded classifier and the loader must accept exactly the same bytes.
 *
 * Publication only needs to know whether a legacy file is a loadable v1, and it
 * was answering that by hydrating a whole KnowledgeGraph -- twice per file on
 * the refusal path, on every generate. The bounded classifier answers the same
 * question without building the graph, which is only safe while the two agree.
 *
 * The record-bound row is here because dropping it is exactly the weakening
 * that slipped through first: a structurally fine artifact past the record
 * limit classified as valid while the loader refused it.
 */

const v1 = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  schema_version: 1,
  directed: true,
  nodes: [{ id: 'a' }],
  links: [],
  ...extra,
})

const CASES: ReadonlyArray<readonly [string, string]> = [
  ['a minimal v1 artifact', v1()],
  ['a v1 artifact using edges', JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'a' }], edges: [] })],
  ['schema_version 2 in the legacy shape', v1({ schema_version: 2 })],
  ['invalid JSON', '{ "schema_version": 1, '],
  ['JSON that is not an object', '[1, 2, 3]'],
  ['a record missing nodes', JSON.stringify({ schema_version: 1, directed: true, links: [] })],
  ['a record missing directed', JSON.stringify({ schema_version: 1, nodes: [], links: [] })],
  ['an unrelated JSON document', JSON.stringify({ hello: 'world' })],
  ['v2 identity at the legacy path', JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [], facts: [] })],
  ['text that is not JSON at all', 'not json'],
  ['past the record bound', JSON.stringify({
    schema_version: 1,
    directed: true,
    nodes: Array.from({ length: 1_000_001 }, (_, index) => ({ id: `n${index}` })),
    links: [],
  })],
]

/** Whether the loader accepts these bytes as v1. */
function loaderAcceptsAsV1(text: string): boolean {
  try {
    return loadGraphArtifact(text).format === 'v1'
  } catch {
    return false
  }
}

describe('the bounded legacy classifier agrees with the loader', () => {
  it.each(CASES)('agrees on %s', (_label, text) => {
    expect(classifyLegacyArtifactBytes(text) === 'valid_v1').toBe(loaderAcceptsAsV1(text))
  })

  it('distinguishes too large from unreadable', () => {
    // Publication words its refusal from this, and sending someone to look for
    // corruption in an uncorrupted file wastes the trip.
    const oversized = JSON.stringify({
      schema_version: 1,
      directed: true,
      nodes: Array.from({ length: 1_000_001 }, (_, index) => ({ id: `n${index}` })),
      links: [],
    })

    expect(classifyLegacyArtifactBytes(oversized)).toBe('too_large')
    expect(classifyLegacyArtifactBytes('{ broken')).toBe('unreadable')
  })

  it('treats a moved marker as not a v1 artifact', () => {
    expect(classifyLegacyArtifactBytes(GRAPH_ARTIFACT_V2_TOMBSTONE)).not.toBe('valid_v1')
  })
})
