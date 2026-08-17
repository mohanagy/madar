import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import {
  GraphArtifactStateError,
  classifyWorkspaceGraph,
} from '../../src/contracts/graph-artifact-selection.js'
import { buildDoctorReport } from '../../src/infrastructure/doctor.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { resolveWorkspaceGraphPath } from '../../src/shared/workspace.js'

const STALE_V1 = JSON.stringify({
  schema_version: 1,
  directed: true,
  nodes: [{ id: 'stale', label: 'stale' }],
  links: [],
})

/**
 * A genuine B1-era workspace: a valid canonical artifact beside a live v1.
 *
 * Built by generating and then restoring a v1 over the tombstone, so the
 * canonical artifact is real rather than hand-written.
 */
function mixedWorkspace(): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'mixed-state-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export function a() { b() }\nexport function b() {}\n')
  generateGraph(root, { noHtml: true })
  const out = join(root, 'out')
  writeFileSync(join(out, 'graph.json'), STALE_V1)
  return { root, out }
}

const cleanup = (root: string): void => rmSync(root, { recursive: true, force: true })

describe('a mixed workspace is ambiguous, so default loads refuse it', () => {
  it('classifies the B1 shape as mixed', () => {
    const { root, out } = mixedWorkspace()
    try {
      expect(classifyWorkspaceGraph(out).state).toBe('mixed_v2_and_live_v1')
    } finally {
      cleanup(root)
    }
  })

  it.each([
    ['the conventional legacy spelling', 'out/graph.json'],
    ['the conventional canonical spelling', 'out/graph.madar'],
    ['a backslash spelling', 'out\\graph.json'],
    ['a dot-prefixed spelling', './out/graph.json'],
  ])('fails closed for a default load using %s', (_label, spelling) => {
    const { root } = mixedWorkspace()
    try {
      let thrown: GraphArtifactStateError | undefined
      try {
        resolveWorkspaceGraphPath(spelling, root, 'default')
      } catch (error) {
        thrown = error as GraphArtifactStateError
      }

      // Nothing durable proves the two files came from one trustworthy
      // generation, so choosing either silently is the failure mode.
      expect(thrown).toBeInstanceOf(GraphArtifactStateError)
      expect(thrown?.state).toBe('mixed_v2_and_live_v1')
      expect(thrown?.message).toMatch(/madar generate \./)
    } finally {
      cleanup(root)
    }
  })

  it('names both artifacts and the repair in the refusal', () => {
    const { root } = mixedWorkspace()
    try {
      expect(() => resolveWorkspaceGraphPath('out/graph.json', root, 'default'))
        .toThrow(/graph\.madar.*graph\.json|graph\.json.*graph\.madar/s)
      expect(() => resolveWorkspaceGraphPath('out/graph.json', root, 'default'))
        .toThrow(/interrupted cutover|rollback/)
    } finally {
      cleanup(root)
    }
  })
})

describe('explicit selection still reaches a named artifact', () => {
  it('loads the canonical artifact when it is named', () => {
    const { root, out } = mixedWorkspace()
    try {
      const resolved = resolveWorkspaceGraphPath('out/graph.madar', root, 'explicit')
      expect(loadGraph(join(out, 'graph.madar')).numberOfNodes()).toBeGreaterThan(0)
      expect(resolved).toContain('graph.madar')
    } finally {
      cleanup(root)
    }
  })

  it('loads the live v1 degraded when it is named', () => {
    const { root, out } = mixedWorkspace()
    try {
      // Exactly one node in the stale v1, so settling for it is visible.
      expect(loadGraph(join(out, 'graph.json')).numberOfNodes()).toBe(1)
    } finally {
      cleanup(root)
    }
  })

  it('loads a preserved backup degraded when it is named', () => {
    const root = mkdtempSync(join(tmpdir(), 'mixed-backup-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'graph.v1.json'), STALE_V1)
    writeFileSync(join(out, 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)

    try {
      expect(loadGraph(join(out, 'graph.v1.json')).numberOfNodes()).toBe(1)
    } finally {
      cleanup(root)
    }
  })
})

describe('full generation repairs a mixed workspace', () => {
  it.each([
    ['--update', { update: true }],
    ['--cluster-only', { clusterOnly: true }],
  ])('refuses %s, which would have to trust one artifact', (_label, options) => {
    const { root } = mixedWorkspace()
    try {
      expect(() => generateGraph(root, { noHtml: true, ...options }))
        .toThrow(GraphArtifactStateError)
    } finally {
      cleanup(root)
    }
  })

  it('rebuilds from source and leaves the workspace current', () => {
    const { root, out } = mixedWorkspace()
    try {
      const result = generateGraph(root, { noHtml: true })

      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')
      expect(result.graphPath).toBe(join(out, 'graph.madar'))
      expect(readFileSync(join(out, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
    } finally {
      cleanup(root)
    }
  })

  it('preserves the live v1 as the backup, byte for byte', () => {
    const { root, out } = mixedWorkspace()
    try {
      generateGraph(root, { noHtml: true })

      // The v1 that was live at repair time is the only copy of what the
      // workspace held, so it must survive unaltered.
      expect(readFileSync(join(out, 'graph.v1.json'), 'utf8')).toBe(STALE_V1)
    } finally {
      cleanup(root)
    }
  })

  it('repairs with a preserved backup that differs from the live v1', () => {
    const { root, out } = mixedWorkspace()
    const original = JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'original' }], links: [] })
    writeFileSync(join(out, 'graph.v1.json'), original)
    expect(readFileSync(join(out, 'graph.json'), 'utf8')).not.toBe(original)

    try {
      // Inverted by the maintainer ruling. graph.v1.json is the immutable
      // first backup and the live file is whatever happened after it, so the
      // two are expected to diverge. Requiring them to match wedged the only
      // repair a mixed workspace has. Neither ambiguous v1 becomes the new
      // graph -- that is generated from source -- and the backup is untouched.
      generateGraph(root, { noHtml: true })

      expect(readFileSync(join(out, 'graph.v1.json'), 'utf8')).toBe(original)
      expect(readFileSync(join(out, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')
    } finally {
      cleanup(root)
    }
  })

  it('creates no second backup file during repair', () => {
    const { root, out } = mixedWorkspace()
    writeFileSync(join(out, 'graph.v1.json'),
      JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'original' }], links: [] }))

    try {
      generateGraph(root, { noHtml: true })

      // One durable backup, not a rotation scheme.
      const backups = readdirSync(out).filter((name) => name.startsWith('graph.v1'))
      expect(backups).toEqual(['graph.v1.json'])
    } finally {
      cleanup(root)
    }
  })

  it('keeps the same backup across repeated repair', () => {
    const { root, out } = mixedWorkspace()
    const original = JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'original' }], links: [] })
    writeFileSync(join(out, 'graph.v1.json'), original)

    try {
      generateGraph(root, { noHtml: true })
      generateGraph(root, { noHtml: true })
      generateGraph(root, { noHtml: true })

      expect(readFileSync(join(out, 'graph.v1.json'), 'utf8')).toBe(original)
      expect(readdirSync(out).filter((name) => name.startsWith('graph.v1'))).toEqual(['graph.v1.json'])
    } finally {
      cleanup(root)
    }
  })

  it('repairs when the preserved backup already matches the live v1', () => {
    const { root, out } = mixedWorkspace()
    writeFileSync(join(out, 'graph.v1.json'), STALE_V1)

    try {
      // Same bytes, so there is no ambiguity about what the pre-cutover state
      // was and the repair proceeds without touching the backup.
      generateGraph(root, { noHtml: true })

      expect(readFileSync(join(out, 'graph.v1.json'), 'utf8')).toBe(STALE_V1)
      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')
    } finally {
      cleanup(root)
    }
  })

  it('leaves a repaired workspace loadable by default', () => {
    const { root, out } = mixedWorkspace()
    try {
      generateGraph(root, { noHtml: true })

      const resolved = resolveWorkspaceGraphPath('out/graph.json', root, 'default')
      expect(resolved).toBe(join(out, 'graph.madar'))
      expect(loadGraph(resolved).numberOfNodes()).toBeGreaterThan(0)
    } finally {
      cleanup(root)
    }
  })

  it('is repeatable once repaired', () => {
    const { root, out } = mixedWorkspace()
    try {
      generateGraph(root, { noHtml: true })
      expect(() => generateGraph(root, { noHtml: true, update: true })).not.toThrow()
      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')
    } finally {
      cleanup(root)
    }
  })
})

describe('doctor names the ambiguous state instead of refusing', () => {
  it('identifies the mixed workspace and recommends full generation', () => {
    const { root } = mixedWorkspace()
    try {
      const report = buildDoctorReport({ projectDir: root })

      // Doctor reports rather than throwing: an operator running it is trying
      // to find out what is wrong, so failing closed would hide the answer.
      expect(report.graph.workspaceState).toBe('mixed_v2_and_live_v1')
      expect(report.graph.recommendation).toMatch(/madar generate \./)
      expect(report.graph.recommendation).toMatch(/ambiguous|interrupted-cutover|rollback/)
    } finally {
      cleanup(root)
    }
  })

  it('reports an ordinary workspace as current', () => {
    const { root, out } = mixedWorkspace()
    try {
      generateGraph(root, { noHtml: true })
      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')

      const report = buildDoctorReport({ projectDir: root })
      expect(report.graph.workspaceState).toBe('current_v2')
      expect(report.graph.recommendation).not.toMatch(/ambiguous/)
    } finally {
      cleanup(root)
    }
  })
})

describe('other broken states keep failing closed by default', () => {
  it('refuses a tombstone with no canonical artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'moved-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)
    writeFileSync(join(out, 'graph.v1.json'), STALE_V1)

    try {
      let thrown: GraphArtifactStateError | undefined
      try {
        resolveWorkspaceGraphPath('out/graph.json', root, 'default')
      } catch (error) {
        thrown = error as GraphArtifactStateError
      }

      // A preserved backup is rollback evidence, not an active graph.
      expect(thrown?.state).toBe('moved_without_canonical')
      expect(existsSync(join(out, 'graph.v1.json'))).toBe(true)
    } finally {
      cleanup(root)
    }
  })

  it('refuses a corrupt canonical artifact without falling back to the backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'invalid-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'graph.madar'), 'MADAR_GRAPH_ARTIFACT/2\n{ truncated')
    writeFileSync(join(out, 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)
    writeFileSync(join(out, 'graph.v1.json'), STALE_V1)

    try {
      let thrown: GraphArtifactStateError | undefined
      try {
        resolveWorkspaceGraphPath('out/graph.json', root, 'default')
      } catch (error) {
        thrown = error as GraphArtifactStateError
      }

      expect(thrown?.state).toBe('invalid_current_v2')
    } finally {
      cleanup(root)
    }
  })

  it('still loads a genuinely pre-cutover workspace by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-only-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'graph.json'), STALE_V1)

    try {
      // No canonical artifact and no tombstone: nothing ambiguous about it.
      const resolved = resolveWorkspaceGraphPath('out/graph.json', root, 'default')
      expect(resolved).toBe(join(out, 'graph.json'))
      expect(loadGraph(resolved).numberOfNodes()).toBe(1)
    } finally {
      cleanup(root)
    }
  })
})
