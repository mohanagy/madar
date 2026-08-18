import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_HEADER } from '../../src/contracts/graph-artifact.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph, readGraphArtifactRecord } from '../../src/runtime/serve.js'

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'artifact-record-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const name of ['a', 'b', 'c']) {
    writeFileSync(
      join(root, 'src', `${name}.ts`),
      `export function ${name}() { helper${name}() }\nexport function helper${name}() {}\n`,
    )
  }
  generateGraph(root, { noHtml: true })
  return root
}

function storedLabels(root: string): Record<string, string> {
  const artifact = readFileSync(join(root, 'out', 'graph.madar'), 'utf8')
  return (JSON.parse(artifact.slice(GRAPH_ARTIFACT_V2_HEADER.length)) as {
    community_labels?: Record<string, string>
  }).community_labels ?? {}
}

describe('reading stored artifact fields after the cutover', () => {
  it('returns the payload of a canonical artifact', () => {
    const root = workspace()

    try {
      const expected = storedLabels(root)
      expect(Object.keys(expected).length).toBeGreaterThan(0)

      // Bare JSON.parse threw on the v2 header and the failure was swallowed
      // to {}, so every stored field silently disappeared. community_labels
      // are authoritative over derived ones, which made this change labelling
      // rather than fail.
      const record = readGraphArtifactRecord(join(root, 'out', 'graph.madar'))

      expect(record.community_labels).toEqual(expected)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the legacy path to the same payload', () => {
    const root = workspace()

    try {
      // graph.json is a tombstone now, so reading it literally yields nothing.
      expect(readGraphArtifactRecord(join(root, 'out', 'graph.json')).community_labels)
        .toEqual(storedLabels(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads the same artifact loadGraph does for an explicit legacy request', () => {
    const root = workspace()
    const out = join(root, 'out')
    writeFileSync(
      join(out, 'graph.json'),
      JSON.stringify({
        schema_version: 1,
        directed: true,
        nodes: [{ id: 'stale' }],
        links: [],
        community_labels: { 0: 'STALE V1 LABEL' },
      }),
    )

    try {
      // Reading stored fields from the canonical artifact while loadGraph
      // returns the named v1 splits one request across two artifacts:
      // structure from one, labels and metadata from the other.
      const record = readGraphArtifactRecord(join(out, 'graph.json'))
      const graph = loadGraph(join(out, 'graph.json'))

      expect(record.community_labels).toEqual({ 0: 'STALE V1 LABEL' })
      expect(graph.numberOfNodes()).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still reads a pre-cutover v1 artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-record-v1-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'graph.json'),
      JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [], community_labels: { 0: 'Legacy' } }),
    )

    try {
      expect(readGraphArtifactRecord(join(out, 'graph.json')).community_labels).toEqual({ 0: 'Legacy' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an empty record for an unreadable artifact rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-record-bad-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'graph.json'), 'not json and not an artifact')

    try {
      expect(readGraphArtifactRecord(join(out, 'graph.json'))).toEqual({})
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
