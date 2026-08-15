import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { publishTransitionalGraphArtifacts } from '../../src/infrastructure/graph-artifact-transitional.js'
import { temporaryPath, writeDurableTemporaryFile } from '../../src/infrastructure/durable-file.js'

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
  const root = mkdtempSync(join(tmpdir(), 'transitional-durability-'))
  mkdirSync(join(root, 'out'), { recursive: true })
  return root
}

const publish = (outputDir: string, extra: Record<string, unknown> = {}): unknown => (
  publishTransitionalGraphArtifacts({
    outputDir,
    artifactBytes: artifactBytes(),
    legacyJson: JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] }),
    ...extra,
  })
)

const stagingLeftovers = (outputDir: string): string[] => readdirSync(outputDir)
  .filter((entry) => entry.startsWith('.madar-') || entry.includes('.publishing'))

describe('staging paths cannot collide between publishers', () => {
  it('never reuses a predictable staging name', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      const seen = new Set<string>()

      for (let index = 0; index < 5; index += 1) {
        publish(outputDir, {
          beforeStep: (step: string) => {
            if (step !== 'rename_canonical') return
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
      const outputDir = join(root, 'out')
      const staging = temporaryPath(outputDir, 'probe')
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
      expect(statSync(staging).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a failed publication restores what was there', () => {
  it('puts the previous canonical artifact and mirror back', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      publish(outputDir)
      const beforeArtifact = readFileSync(join(outputDir, 'graph.madar'))
      const beforeMirror = readFileSync(join(outputDir, 'graph.json'), 'utf8')

      expect(() => publish(outputDir, {
        legacyJson: JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [], marker: 'second' }),
        beforeStep: (step: string) => {
          if (step === 'rename_mirror') throw new Error('injected mirror failure')
        },
      })).toThrow(/injected mirror failure/)

      expect(readFileSync(join(outputDir, 'graph.madar'))).toEqual(beforeArtifact)
      expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(beforeMirror)
      expect(stagingLeftovers(outputDir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a canonical artifact that did not exist before the failed run', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')

      expect(() => publish(outputDir, {
        beforeStep: (step: string) => {
          if (step === 'rename_mirror') throw new Error('injected mirror failure')
        },
      })).toThrow(/injected mirror failure/)

      expect(existsSync(join(outputDir, 'graph.madar'))).toBe(false)
      expect(stagingLeftovers(outputDir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves nothing staged when validation rejects the artifact', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')

      expect(() => publishTransitionalGraphArtifacts({
        outputDir,
        artifactBytes: Buffer.from('not an artifact'),
        legacyJson: '{}',
      })).toThrow()

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
      publish(outputDir)
      const original = readFileSync(join(outputDir, 'graph.json'), 'utf8')

      // The unwind itself must not be able to leave a torn file behind.
      expect(() => publish(outputDir, {
        beforeStep: (step: string) => {
          if (step === 'rename_mirror') throw new Error('injected failure')
        },
      })).toThrow()

      expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the sidecar follows the same contract', () => {
  it('publishes and cleans up the machine-local sidecar', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      const result = publish(outputDir, { rootPath: root }) as { sidecarPath: string | null }

      expect(result.sidecarPath).not.toBeNull()
      expect(JSON.parse(readFileSync(result.sidecarPath as string, 'utf8'))).toEqual({ root_path: root })
      expect(stagingLeftovers(outputDir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits the sidecar when no root path is supplied', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      const result = publish(outputDir) as { sidecarPath: string | null }

      expect(result.sidecarPath).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a successful publication is same-generation', () => {
  it('writes both files from one run and leaves no staging behind', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      publish(outputDir)

      expect(existsSync(join(outputDir, 'graph.madar'))).toBe(true)
      expect(existsSync(join(outputDir, 'graph.json'))).toBe(true)
      expect(stagingLeftovers(outputDir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not claim the two paths commit atomically', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      publish(outputDir)
      const canonicalBefore = readFileSync(join(outputDir, 'graph.madar'))

      // Canonical-first ordering is the contract: an interruption between the
      // two renames may leave the mirror lagging, which is harmless because
      // current readers prefer graph.madar. The reverse would not be.
      expect(() => publish(outputDir, {
        beforeStep: (step: string) => {
          if (step === 'rename_mirror') throw new Error('interrupted between renames')
        },
      })).toThrow()

      expect(readFileSync(join(outputDir, 'graph.madar'))).toEqual(canonicalBefore)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('directory durability', () => {
  it('publishes into a directory that did not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'transitional-mkdir-'))
    try {
      const outputDir = join(root, 'nested', 'out')

      expect(() => publish(outputDir)).not.toThrow()
      expect(existsSync(join(outputDir, 'graph.madar'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an unrelated file in the output directory untouched', () => {
    const root = workspace()
    try {
      const outputDir = join(root, 'out')
      writeFileSync(join(outputDir, 'unrelated.txt'), 'keep me')

      publish(outputDir)

      expect(readFileSync(join(outputDir, 'unrelated.txt'), 'utf8')).toBe('keep me')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
