import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadGraphArtifact, parseGraphArtifact, readBoundedUtf8, readGraphArtifactReceipt } from '../../src/adapters/filesystem/graph-artifact.js'
import { GRAPH_ARTIFACT_REGENERATE_MESSAGE, serializeGraphArtifact } from '../../src/domain/graph/artifact.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'

const roots: string[] = []

function testRoot(): string {
  const parent = join(process.cwd(), 'out', 'test-runtime')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, 'madar-graph-artifact-'))
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

describe('stored graph artifact guard', () => {
  it('rejects a canonical TypeScript graph without a valid Core v2 build state', () => {
    const artifact = serializeGraphArtifact(new KnowledgeGraph({ canonical_typescript_index: true }))
    const root = testRoot()
    const graphPath = join(root, 'graph.json')
    roots.push(root)
    writeFileSync(graphPath, artifact)

    expect(() => parseGraphArtifact(artifact)).toThrow(GRAPH_ARTIFACT_REGENERATE_MESSAGE)
    expect(() => loadGraphArtifact(graphPath)).toThrow(GRAPH_ARTIFACT_REGENERATE_MESSAGE)
  })

  it('preserves intentionally non-canonical and federated graphs', () => {
    const graph = parseGraphArtifact(serializeGraphArtifact(new KnowledgeGraph({ federated_repos: ['web', 'api'] })))

    expect(graph.graph.federated_repos).toEqual(['web', 'api'])
  })

  it('caches one immutable receipt and reloads after atomic replacement', () => {
    const root = testRoot()
    const graphPath = join(root, 'graph.json')
    const replacementPath = join(root, 'replacement.json')
    roots.push(root)
    const firstArtifact = serializeGraphArtifact(new KnowledgeGraph({ federated_repos: ['web'] }))
    const nextArtifact = serializeGraphArtifact(new KnowledgeGraph({ federated_repos: ['api'] }))
    writeFileSync(graphPath, firstArtifact)

    const first = readGraphArtifactReceipt(graphPath)
    expect(readGraphArtifactReceipt(graphPath, first)).toBe(first)
    expect(first.graphSha256).toBe(createHash('sha256').update(firstArtifact).digest('hex'))

    writeFileSync(replacementPath, nextArtifact)
    renameSync(replacementPath, graphPath)
    const next = readGraphArtifactReceipt(graphPath, first)

    expect(next).not.toBe(first)
    expect(next.identity).not.toBe(first.identity)
    expect(next.graphSha256).toBe(createHash('sha256').update(nextArtifact).digest('hex'))
    expect(next.graph.graph.federated_repos).toEqual(['api'])
  })

  it('caps descriptor reads before decoding text', () => {
    const root = testRoot()
    const path = join(root, 'bounded.txt')
    roots.push(root)
    writeFileSync(path, '12345678901')
    const descriptor = openSync(path, 'r')
    try { expect(() => readBoundedUtf8(descriptor, 10, 'too large')).toThrow('too large') }
    finally { closeSync(descriptor) }
  })
})
