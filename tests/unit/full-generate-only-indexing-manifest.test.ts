import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import {
  indexingManifestPathForGraph,
  readIndexingManifestForGraph,
} from '../../src/infrastructure/indexing-manifest.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — D2.
 *
 * A prior indexing manifest must not re-enter ordinary generation as semantic
 * input. The external reader-call trap detects a reconnection, but a defect is
 * only attributable when a committed test owns the failure, so this test counts
 * calls through the real module graph.
 */
const POISON_PATH = 'poisoned/only-in-the-prior-manifest_722.ts'

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-d2-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\nexport function realSymbol(){return alpha}\n')
  return dir
}

/** Seed a poisoned outcome into the manifest the real reader actually resolves. */
function poisonPriorManifest(graphPath: string): string {
  const manifestPath = indexingManifestPathForGraph(graphPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    outcomes: Array<Record<string, unknown>>
  }
  const template = manifest.outcomes[0]
  if (!template) throw new Error('fixture produced no indexing outcomes to model the poison on')
  manifest.outcomes = [...manifest.outcomes, { ...template, path: POISON_PATH }]
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return manifestPath
}

describe('FULL-GENERATE-ONLY', () => {
  test('precondition: the real indexing-manifest reader resolves and accepts the poisoned manifest', () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'auto', noHtml: true })
    const manifestPath = poisonPriorManifest(first.graphPath)

    // The reader must resolve exactly this path, or the poison is inert and the
    // assertion below would pass for the wrong reason.
    expect(existsSync(manifestPath)).toBe(true)
    const read = readIndexingManifestForGraph(first.graphPath)
    expect(read).not.toBeNull()
    expect(read?.outcomes.map((outcome) => outcome.path)).toContain(POISON_PATH)
  })

  test('ordinary generation never reads the prior indexing manifest as semantic input', async () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'auto', noHtml: true })
    poisonPriorManifest(first.graphPath)

    vi.resetModules()
    const actual = await vi.importActual<typeof import('../../src/infrastructure/indexing-manifest.js')>(
      '../../src/infrastructure/indexing-manifest.js',
    )
    let readerCalls = 0
    vi.doMock('../../src/infrastructure/indexing-manifest.js', () => ({
      ...actual,
      readIndexingManifestForGraph: (...args: Parameters<typeof actual.readIndexingManifestForGraph>) => {
        readerCalls += 1
        return actual.readIndexingManifestForGraph(...args)
      },
    }))

    try {
      const generateModule = await import('../../src/infrastructure/generate.js')
      const second = generateModule.generateGraph(dir, { extractionMode: 'auto', noHtml: true })

      expect(readerCalls, 'INDEXING_MANIFEST_READER_RECONNECTED').toBe(0)
      expect(second.extractedFiles).toBeGreaterThan(0)
      expect(JSON.stringify(readFileSync(second.graphPath, 'utf8'))).not.toContain(POISON_PATH)
      expect(existsSync(join(dir, 'out/graph.madar.tmp'))).toBe(false)
    } finally {
      vi.doUnmock('../../src/infrastructure/indexing-manifest.js')
      vi.resetModules()
    }
  })
})
