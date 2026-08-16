import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  GRAPH_ARTIFACT_V2_HEADER,
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'
import {
  GraphArtifactStateError,
  GraphArtifactTooLargeError,
  classifyWorkspaceGraph,
  readArtifactWithinBound,
  resolveGraphArtifact,
} from '../../src/contracts/graph-artifact-selection.js'

function canonicalBytes(): Buffer {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'A' })
  graph.addNode('b', { label: 'B' })
  graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-16T00:00:00.000Z',
  })
}

const LIVE_V1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] })

/** Builds an output directory holding exactly the named artifacts. */
function workspace(files: Partial<Record<'canonical' | 'legacy' | 'backup', string | Buffer>>): string {
  const root = mkdtempSync(join(tmpdir(), 'selection-'))
  const out = join(root, 'out')
  mkdirSync(out, { recursive: true })
  if (files.canonical !== undefined) writeFileSync(join(out, 'graph.madar'), files.canonical)
  if (files.legacy !== undefined) writeFileSync(join(out, 'graph.json'), files.legacy)
  if (files.backup !== undefined) writeFileSync(join(out, 'graph.v1.json'), files.backup)
  return out
}

const cleanup = (out: string): void => rmSync(join(out, '..'), { recursive: true, force: true })

describe('workspace state precedence', () => {
  it.each([
    ['tombstone + valid canonical', { canonical: canonicalBytes(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, 'current_v2'],
    ['tombstone + valid canonical + backup', { canonical: canonicalBytes(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, 'current_v2'],
    ['tombstone + no canonical', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, 'moved_without_canonical'],
    ['tombstone + no canonical + backup', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, 'moved_without_canonical'],
    ['tombstone + corrupt canonical', { canonical: 'not an artifact', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, 'invalid_current_v2'],
    ['tombstone + corrupt canonical + backup', { canonical: 'not an artifact', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, 'invalid_current_v2'],
    ['canonical + live v1 (B1 shape)', { canonical: canonicalBytes(), legacy: LIVE_V1 }, 'mixed_v2_and_live_v1'],
    ['canonical only, no tombstone', { canonical: canonicalBytes() }, 'current_v2'],
    ['live v1 only, no tombstone', { legacy: LIVE_V1 }, 'legacy_v1_only'],
    ['live v1 + backup, no tombstone', { legacy: LIVE_V1, backup: LIVE_V1 }, 'legacy_v1_only'],
    ['nothing', {}, 'missing'],
  ])('%s -> %s', (_label, files, expected) => {
    const out = workspace(files as never)
    try {
      expect(classifyWorkspaceGraph(out).state).toBe(expected)
    } finally {
      cleanup(out)
    }
  })

  it('never classifies tombstone + backup as legacy_v1_only', () => {
    const out = workspace({ legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 })
    try {
      const classification = classifyWorkspaceGraph(out)

      // The precedence defect this contract exists to close: a preserved
      // backup must not promote a moved workspace back to usable.
      expect(classification.state).toBe('moved_without_canonical')
      expect(classification.hasBackup).toBe(true)
    } finally {
      cleanup(out)
    }
  })
})

describe('default intent refuses every ambiguous or broken state', () => {
  it.each([
    ['mixed', { canonical: canonicalBytes(), legacy: LIVE_V1 }, 'mixed_v2_and_live_v1'],
    ['moved without canonical', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, 'moved_without_canonical'],
    ['moved with backup', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, 'moved_without_canonical'],
    ['invalid canonical', { canonical: 'broken', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, 'invalid_current_v2'],
    ['invalid canonical with backup', { canonical: 'broken', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, 'invalid_current_v2'],
    ['missing', {}, 'missing'],
  ])('%s fails closed', (_label, files, state) => {
    const out = workspace(files as never)
    try {
      let thrown: unknown
      try {
        resolveGraphArtifact(join(out, 'graph.json'), { intent: 'default' })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(GraphArtifactStateError)
      expect((thrown as GraphArtifactStateError).state).toBe(state)
    } finally {
      cleanup(out)
    }
  })

  it('reports the backup for diagnosis without selecting it', () => {
    const out = workspace({ legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 })
    try {
      try {
        resolveGraphArtifact(join(out, 'graph.json'), { intent: 'default' })
        throw new Error('expected a refusal')
      } catch (error) {
        const stateError = error as GraphArtifactStateError
        // Visible to an operator, never an automatic selection.
        expect(stateError.legacyBackupPath).toBe(join(out, 'graph.v1.json'))
        expect(stateError.state).toBe('moved_without_canonical')
      }
    } finally {
      cleanup(out)
    }
  })

  it('succeeds on a healthy cutover workspace', () => {
    const out = workspace({ canonical: canonicalBytes(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    try {
      const selection = resolveGraphArtifact(join(out, 'graph.json'), { intent: 'default' })

      expect(selection.format).toBe('v2')
      expect(selection.selectedPhysicalPath).toBe(join(out, 'graph.madar'))
      expect(selection.selection).toBe('canonical_default')
    } finally {
      cleanup(out)
    }
  })

  it('loads a genuinely pre-cutover workspace degraded', () => {
    const out = workspace({ legacy: LIVE_V1 })
    try {
      const selection = resolveGraphArtifact(join(out, 'graph.json'), { intent: 'default' })

      expect(selection.format).toBe('v1')
      expect(selection.workspaceState).toBe('legacy_v1_only')
    } finally {
      cleanup(out)
    }
  })
})

describe('explicit intent reaches specific artifacts', () => {
  it('loads an explicit canonical artifact from a mixed workspace', () => {
    const out = workspace({ canonical: canonicalBytes(), legacy: LIVE_V1 })
    try {
      const selection = resolveGraphArtifact(join(out, 'graph.madar'), { intent: 'explicit' })

      // Same workspace that fails closed by default.
      expect(selection.format).toBe('v2')
      expect(selection.selection).toBe('explicit_v2')
      expect(selection.workspaceState).toBe('mixed_v2_and_live_v1')
    } finally {
      cleanup(out)
    }
  })

  it('loads an explicit live v1 from a mixed workspace degraded', () => {
    const out = workspace({ canonical: canonicalBytes(), legacy: LIVE_V1 })
    try {
      const selection = resolveGraphArtifact(join(out, 'graph.json'), { intent: 'explicit' })

      expect(selection.format).toBe('v1')
      expect(selection.selection).toBe('explicit_legacy')
    } finally {
      cleanup(out)
    }
  })

  it('loads an explicit backup degraded even when it is not JSON-shaped', () => {
    // A JSON-shaped backup would also be reached by the generic fallthrough, so
    // it cannot show the dedicated backup branch exists. Content that the
    // fallthrough rejects can.
    const out = workspace({ legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 })
    try {
      const selection = resolveGraphArtifact(join(out, 'graph.v1.json'), { intent: 'explicit' })

      expect(selection.format).toBe('v1')
      expect(selection.selection).toBe('explicit_legacy')
      expect(selection.selectedPhysicalPath).toBe(join(out, 'graph.v1.json'))
      expect(selection.workspaceState).toBe('moved_without_canonical')
    } finally {
      cleanup(out)
    }
  })

  it('resolves an explicit tombstone to its valid sibling', () => {
    const out = workspace({ canonical: canonicalBytes(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    try {
      const selection = resolveGraphArtifact(join(out, 'graph.json'), { intent: 'explicit' })

      expect(selection.selection).toBe('tombstone_alias')
      expect(selection.selectedPhysicalPath).toBe(join(out, 'graph.madar'))
    } finally {
      cleanup(out)
    }
  })

  it('refuses an explicit tombstone whose sibling is missing', () => {
    const out = workspace({ legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 })
    try {
      let thrown: GraphArtifactStateError | undefined
      try {
        resolveGraphArtifact(join(out, 'graph.json'), { intent: 'explicit' })
      } catch (error) {
        thrown = error as GraphArtifactStateError
      }

      // The state matters, not just the error class: without it, deleting the
      // tombstone-forwarding branch entirely still "passes" because the generic
      // unreadable-path refusal throws the same type. A backup is present and
      // still does not rescue this.
      expect(thrown?.state).toBe('moved_without_canonical')
      expect(thrown?.expectedCanonicalPath).toBe(join(out, 'graph.madar'))
    } finally {
      cleanup(out)
    }
  })

  it('refuses an explicit backup request when no backup exists', () => {
    const out = workspace({ canonical: canonicalBytes(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    try {
      expect(() => resolveGraphArtifact(join(out, 'graph.v1.json'), { intent: 'explicit' }))
        .toThrow(/No readable legacy backup/)
    } finally {
      cleanup(out)
    }
  })

  it('refuses an explicit path that is not any known artifact shape', () => {
    const out = workspace({ canonical: canonicalBytes() })
    writeFileSync(join(out, 'notes.txt'), 'plain text, not a graph')
    try {
      expect(() => resolveGraphArtifact(join(out, 'notes.txt'), { intent: 'explicit' }))
        .toThrow(/not a readable graph artifact/)
    } finally {
      cleanup(out)
    }
  })

  it('refuses an explicit canonical artifact that is corrupt', () => {
    const out = workspace({ canonical: 'broken', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 })
    try {
      expect(() => resolveGraphArtifact(join(out, 'graph.madar'), { intent: 'explicit' }))
        .toThrow(GraphArtifactStateError)
    } finally {
      cleanup(out)
    }
  })
})

describe('physical and logical paths are separate', () => {
  it('defaults the logical path to the artifact actually selected', () => {
    const out = workspace({ canonical: canonicalBytes(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    try {
      // No logicalPath supplied, so this exercises the default rather than
      // proving the option is echoed back.
      const selection = resolveGraphArtifact(join(out, 'graph.json'), { intent: 'default' })

      expect(selection.selectedLogicalPath).toBe(join(out, 'graph.madar'))
      expect(selection.selectedLogicalPath).not.toBe(selection.requestedPath)
    } finally {
      cleanup(out)
    }
  })

  it('reports the supplied logical path while reading the physical one', () => {
    const out = workspace({ canonical: canonicalBytes(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    try {
      const selection = resolveGraphArtifact(join(out, 'graph.json'), {
        intent: 'default',
        logicalPath: 'out/graph.madar',
      })

      // What a linked worktree needs: read the redirected artifact, publish the
      // conventional path.
      expect(selection.selectedLogicalPath).toBe('out/graph.madar')
      expect(selection.selectedPhysicalPath).toBe(join(out, 'graph.madar'))
      expect(selection.selectedPhysicalPath).not.toBe(selection.selectedLogicalPath)
    } finally {
      cleanup(out)
    }
  })
})

describe('bounds are mandatory', () => {
  it('rejects an oversized artifact before reading it', () => {
    const out = workspace({ canonical: canonicalBytes() })
    try {
      expect(() => readArtifactWithinBound(join(out, 'graph.madar'), 32))
        .toThrow(GraphArtifactTooLargeError)
    } finally {
      cleanup(out)
    }
  })

  it('applies the default bound when none is supplied', () => {
    const out = workspace({ canonical: canonicalBytes() })
    try {
      // Omitting the option must not mean unlimited; a normal artifact passes.
      expect(readArtifactWithinBound(join(out, 'graph.madar')).byteLength).toBeGreaterThan(0)
    } finally {
      cleanup(out)
    }
  })

  it('refuses a non-positive or unsafe bound rather than treating it as absent', () => {
    const out = workspace({ canonical: canonicalBytes() })
    try {
      expect(() => readArtifactWithinBound(join(out, 'graph.madar'), 0)).toThrow(TypeError)
      expect(() => readArtifactWithinBound(join(out, 'graph.madar'), -1)).toThrow(TypeError)
      expect(() => readArtifactWithinBound(join(out, 'graph.madar'), 1.5)).toThrow(TypeError)
    } finally {
      cleanup(out)
    }
  })

  it.each([
    ['truncated mid-payload', `${GRAPH_ARTIFACT_V2_HEADER}{ "nodes": [`],
    ['payload is not JSON', `${GRAPH_ARTIFACT_V2_HEADER}not json at all`],
    ['header only, empty payload', GRAPH_ARTIFACT_V2_HEADER],
  ])('treats a canonical artifact that is %s as invalid, not current', (_label, contents) => {
    const out = workspace({ canonical: contents, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    try {
      // A write cut short still begins with the right magic bytes, so a header
      // check called this healthy. That is the likeliest real corruption, and
      // reporting current_v2 hands back a selection that fails on use.
      expect(classifyWorkspaceGraph(out).state).toBe('invalid_current_v2')
    } finally {
      cleanup(out)
    }
  })

  it('reports a canonical artifact that fails the bound as invalid, with no tombstone', () => {
    const out = workspace({ canonical: canonicalBytes() })
    try {
      expect(classifyWorkspaceGraph(out, 64).state).toBe('invalid_current_v2')
    } finally {
      cleanup(out)
    }
  })

  it('reports v1 JSON written to the canonical path as invalid', () => {
    const out = workspace({ canonical: LIVE_V1 })
    try {
      // A downgrade or a bad restore can put v1 content at graph.madar. It is
      // not a usable canonical artifact and must not read as legacy either.
      expect(classifyWorkspaceGraph(out).state).toBe('invalid_current_v2')
    } finally {
      cleanup(out)
    }
  })

  it('does not accept a tombstone prefix as the tombstone', () => {
    // Starts with the tombstone but is not it. With no canonical to fall back
    // on, the honest answer is 'invalid' -- reporting 'moved_without_canonical'
    // would claim a clean cutover that never happened.
    const out = workspace({ legacy: `${GRAPH_ARTIFACT_V2_TOMBSTONE}${'x'.repeat(4096)}` })
    try {
      expect(classifyWorkspaceGraph(out).state).toBe('invalid')
    } finally {
      cleanup(out)
    }
  })

  it('stays current_v2 when a mangled tombstone sits beside a valid canonical', () => {
    const out = workspace({
      canonical: canonicalBytes(),
      legacy: `${GRAPH_ARTIFACT_V2_TOMBSTONE}${'x'.repeat(4096)}`,
    })
    try {
      // The graph is healthy and the mangled legacy file is not JSON, so no
      // old reader can mistake it for a live v1. Nothing here is ambiguous.
      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')
    } finally {
      cleanup(out)
    }
  })

  it('treats an oversized canonical artifact as invalid rather than falling back', () => {
    const out = workspace({ canonical: canonicalBytes(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 })
    try {
      const classification = classifyWorkspaceGraph(out, 64)

      expect(classification.state).toBe('invalid_current_v2')
      expect(classification.hasBackup).toBe(true)
    } finally {
      cleanup(out)
    }
  })
})
