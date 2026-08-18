import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_HEADER, GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact-format.js'
import { parseGraphArtifactV2, serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { graphPathForCommand } from '../../src/shared/workspace.js'

/**
 * The classifier and the parser must reject the same artifacts.
 *
 * They did not. The classifier accepted any JSON body after the magic header,
 * so a header followed by `{}` classified as `current_v2` — a default load
 * selected it, doctor reported the workspace healthy, and the reuse paths
 * proceeded, all before the parser threw an invariant error carrying no
 * workspace state at all. An unusable workspace answered instead of refusing,
 * which is the failure the mixed-state work exists to prevent.
 *
 * A table rather than one case, because the two sides only stay aligned if the
 * whole rule is shared, and the interesting inputs are the ones that parse as
 * JSON but are not artifacts.
 */
function validPayload(): string {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'A' })
  graph.addNode('b', { label: 'B' })
  graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })
  const bytes = serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-18T00:00:00.000Z',
  })
  return bytes.toString('utf8').slice(GRAPH_ARTIFACT_V2_HEADER.length)
}

function withField(mutate: (payload: Record<string, unknown>) => void): string {
  const payload = JSON.parse(validPayload()) as Record<string, unknown>
  mutate(payload)
  return JSON.stringify(payload)
}

const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ['an empty object', '{}'],
  ['a JSON array', '[]'],
  ['a JSON string', '"not an artifact"'],
  ['a JSON number', '42'],
  ['null', 'null'],
  ['no versions block', withField((p) => { delete p.versions })],
  ['an unsupported graph_artifact version', withField((p) => {
    (p.versions as Record<string, unknown>).graph_artifact = 99
  })],
  ['an unknown version field', withField((p) => {
    (p.versions as Record<string, unknown>).invented_field = 1
  })],
  ['a non-boolean directed', withField((p) => { p.directed = 'yes' })],
  ['a missing repository_revision', withField((p) => { delete p.repository_revision })],
  ['nodes that are not an array', withField((p) => { p.nodes = {} })],
  ['facts that are not an array', withField((p) => { p.facts = 'none' })],
  ['occurrences that are not an array', withField((p) => { delete p.occurrences })],
  ['community_labels keyed by a non-integer', withField((p) => { p.community_labels = { alpha: 'x' } })],
  ['a non-empty reserved block', withField((p) => { p.reserved = { future: 1 } })],
]

function workspaceWith(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'canonical-validity-'))
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(join(root, 'out', 'graph.madar'), `${GRAPH_ARTIFACT_V2_HEADER}${body}`)
  writeFileSync(join(root, 'out', 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)
  return root
}

describe('canonical validity agrees with the parser', () => {
  it.each(REJECTED)('refuses %s in both places', (_label, body) => {
    const root = workspaceWith(body)
    try {
      // The parser's verdict, which is the reference.
      expect(() => parseGraphArtifactV2(`${GRAPH_ARTIFACT_V2_HEADER}${body}`)).toThrow()

      // The classifier must reach the same verdict before anything selects it.
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('invalid_current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a real artifact in both places', () => {
    const body = validPayload()
    const root = workspaceWith(body)
    try {
      expect(() => parseGraphArtifactV2(`${GRAPH_ARTIFACT_V2_HEADER}${body}`)).not.toThrow()
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails a default load closed rather than raising a parse error', () => {
    const root = workspaceWith('{}')
    try {
      // The whole point: the refusal names the workspace state, so a caller can
      // act on it. Previously this selected the artifact and then threw
      // GraphArtifactInvariantError, which carries no state and no repair.
      let thrown: unknown
      try {
        loadGraph(graphPathForCommand(
          { graphPath: 'out/graph.madar', graphPathIntent: 'default' },
          root,
        ))
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeDefined()
      expect((thrown as { state?: string }).state).toBe('invalid_current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
