import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { GRAPH_ARTIFACT_V2_TOMBSTONE, serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import {
  type GraphArtifactActivationResult,
  type GraphArtifactActivationStep,
  activateGraphArtifactV2,
} from '../../src/infrastructure/graph-artifact-activation.js'
import { temporaryPath, writeDurableTemporaryFile } from '../../src/infrastructure/durable-file.js'

/**
 * Durability contract for the cutover publisher.
 *
 * These properties were established for the transitional B1 publisher and
 * carried over when #705 replaced it: the publisher changed, the guarantees
 * did not. Rollback, backup-conflict and interruption semantics live in
 * graph-artifact-activation.test.ts; this file covers staging, permissions,
 * the sidecar, and what a failed run leaves behind.
 */

function artifactBytes(): Buffer {
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

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'activation-durability-'))
  mkdirSync(join(root, 'out'), { recursive: true })
  return root
}

const LIVE_V1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] })

interface ActivateExtras {
  readonly sidecarRootPath?: string
  readonly beforeStep?: (step: GraphArtifactActivationStep) => void
}

const activate = (root: string, extra: ActivateExtras = {}): GraphArtifactActivationResult =>
  activateGraphArtifactV2(root, artifactBytes(), extra)

const stagingLeftovers = (outputDir: string): string[] => readdirSync(outputDir)
  .filter((entry) => entry.startsWith('.madar-') || entry.includes('.publishing'))

describe('staging paths cannot collide between publishers', () => {
  it('never reuses a predictable staging name', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      const seen = new Set<string>()

      for (let index = 0; index < 5; index += 1) {
        activate(root, {
          beforeStep: (step) => {
            if (step !== 'rename_v2') return
            for (const entry of readdirSync(outputDir).filter((name) => name.startsWith('.madar-'))) {
              // A fixed ".publishing" name repeated here every run, so a
              // concurrent publisher would stage over live bytes.
              expect(seen.has(entry)).toBe(false)
              seen.add(entry)
            }
          },
        })
      }

      expect(seen.size).toBeGreaterThanOrEqual(5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to stage over an existing file rather than adopting it', () => {
    const root = workspace()
    try {
      const staging = temporaryPath(join(root, 'out'), 'probe')
      writeFileSync(staging, 'someone else is here')

      // Exclusive creation is what makes a staging collision an error instead
      // of one publisher renaming another publisher's bytes into place.
      expect(() => writeDurableTemporaryFile(staging, 'mine')).toThrow(/EEXIST/)
      expect(readFileSync(staging, 'utf8')).toBe('someone else is here')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates staging files with owner-only permissions', () => {
    const root = workspace()
    try {
      const staging = temporaryPath(join(root, 'out'), 'perm')
      writeDurableTemporaryFile(staging, 'x')

      // The artifact can carry machine-local paths, so staging must not be
      // world-readable even briefly.
      //
      // POSIX only. Windows has no POSIX mode bits: Node reports 0o666 for any
      // writable file whatever mode openSync was given, so asserting 0o600
      // there tests the reporting convention rather than the request. The mode
      // is still passed on every platform; only the assertion is narrowed, and
      // the guarantee is not weakened where it exists.
      if (process.platform === 'win32') {
        expect(statSync(staging).isFile()).toBe(true)
        return
      }
      expect(statSync(staging).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a failed activation leaves the previous state', () => {
  it('leaves nothing staged when validation rejects the artifact', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')

      expect(() => activateGraphArtifactV2(root, Buffer.from('not an artifact'))).toThrow()

      // Validation runs before anything is staged, so an unparseable artifact
      // never reaches the output directory even briefly.
      expect(readdirSync(outputDir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores through a staged file rather than writing over the live path', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      activate(root)
      const original = readFileSync(join(outputDir, 'graph.json'), 'utf8')

      // The unwind itself must not be able to leave a torn file behind.
      expect(() => activate(root, {
        beforeStep: (step) => {
          if (step === 'rename_tombstone') throw new Error('injected failure')
        },
      })).toThrow()

      expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('puts a pre-cutover v1 artifact back when the run fails', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      writeFileSync(join(outputDir, 'graph.json'), LIVE_V1)

      expect(() => activate(root, {
        beforeStep: (step) => {
          if (step === 'rename_tombstone') throw new Error('injected failure')
        },
      })).toThrow()

      // A failed cutover must not strand the workspace with its only v1
      // artifact replaced and nothing usable in its place.
      expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(LIVE_V1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a successful activation is same-generation', () => {
  it('publishes the canonical artifact and tombstone and leaves no staging behind', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      activate(root)

      expect(existsSync(join(outputDir, 'graph.madar'))).toBe(true)
      expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
      expect(stagingLeftovers(outputDir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('renames the sidecar, canonical artifact and tombstone in that order', () => {
    const root = workspace()
    try {
      writeFileSync(join(root, 'out', 'graph.json'), LIVE_V1)
      const order: GraphArtifactActivationStep[] = []

      activate(root, {
        sidecarRootPath: root,
        beforeStep: (step) => {
          if (step.startsWith('rename_')) order.push(step)
        },
      })

      // The tombstone is last on purpose: until it lands, an old reader still
      // sees a real v1, and the backup that preserves that v1 is already
      // durable before its original is replaced.
      expect(order).toEqual(['rename_sidecar', 'rename_v2', 'rename_v1_backup', 'rename_tombstone'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the sidecar follows the same contract', () => {
  it('publishes and cleans up the machine-local sidecar', () => {
    const root = workspace()
    try {
      const result = activate(root, { sidecarRootPath: root })

      expect(result.sidecarPath).not.toBeNull()
      expect(JSON.parse(readFileSync(result.sidecarPath as string, 'utf8'))).toEqual({ root_path: root })
      expect(stagingLeftovers(join(root, 'out'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits the sidecar when no root path is supplied', () => {
    const root = workspace()
    try {
      expect(activate(root).sidecarPath).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits the sidecar for a blank root path rather than writing an empty one', () => {
    const root = workspace()
    try {
      expect(activate(root, { sidecarRootPath: '   ' }).sidecarPath).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('directory durability', () => {
  it('publishes into an output directory that did not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'activation-mkdir-'))
    try {
      expect(() => activate(root)).not.toThrow()
      expect(existsSync(join(root, 'out', 'graph.madar'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an unrelated file in the output directory untouched', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      writeFileSync(join(outputDir, 'unrelated.txt'), 'keep me')

      activate(root)

      expect(readFileSync(join(outputDir, 'unrelated.txt'), 'utf8')).toBe('keep me')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
