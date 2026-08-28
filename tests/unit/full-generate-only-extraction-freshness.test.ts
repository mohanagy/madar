import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { saveCached } from '../../src/infrastructure/cache.js'
import { EXTRACTOR_CACHE_VERSION, extract, readCachedExtraction } from '../../src/pipeline/extract.js'
import { fileStemForPath } from '../../src/pipeline/extract/core.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — legacy extraction cache.
 *
 * The reader-call trap showed ordinary generation calling readCachedExtraction
 * twice per run. The supported corridor must extract from repository inputs, so
 * the dispatcher used by supported extraction is given no cache-reader
 * capability at all.
 */
const POISON = 'PoisonSymbolNotInRepository_722'

function fixture(): { root: string, file: string } {
  const root = mkdtempSync(join(tmpdir(), 'madar-722-extract-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const file = join(root, 'src/a.ts')
  writeFileSync(join(root, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(file, 'export const alpha = 1\nexport function realSymbol(){return alpha}\n')
  return { root, file }
}

// readCachedExtraction calls loadCached(filePath) with no root, so it resolves
// the cache against the PROCESS CWD. Planting into the fixture root leaves the
// poison somewhere the reader never looks, which made the precondition fail and
// would have made every downstream assertion vacuous.
function plantPoisonedCache(root: string, file: string): void {
  // A structurally valid cached extraction whose node exists nowhere in source.
  // The reader rejects a payload whose stem does not match the real file, so a
  // hand-picked stem makes the poison inert and every downstream test vacuous.
  const stem = fileStemForPath(file)
  saveCached(file, {
    __madarTsExtractorVersion: EXTRACTOR_CACHE_VERSION,
    __madarFileStem: stem,
    nodes: [{ id: `sym:${POISON}`, label: POISON, file_type: 'code', source_file: file }],
    edges: [],
  }, root)
}

describe('#722 supported extraction consumes no persisted extraction cache', () => {
  const withCwd = <T>(dir: string, fn: () => T): T => {
    const previous = process.cwd()
    process.chdir(dir)
    try { return fn() } finally { process.chdir(previous) }
  }

  it('precondition: the legacy reader really does return the planted marker', () => {
    // Strict on purpose. If the reader returns null the poison is inert and the
    // test below proves nothing, so this must fail rather than pass vacuously.
    const { root, file } = fixture()
    withCwd(root, () => {
      plantPoisonedCache(root, file)
      const cached = readCachedExtraction(file)
      expect(cached).not.toBeNull()
      expect(JSON.stringify(cached)).toContain(POISON)
    })
  })

  it('supported extraction never emits a node that exists only in the cache', () => {
    const { root, file } = fixture()
    withCwd(root, () => {
      plantPoisonedCache(root, file)
      const result = extract([file], { root } as never)
      const labels = result.nodes.map((n) => n.label)
      expect(labels).not.toContain(POISON)
      expect(labels).toContain('realSymbol()')
    })
  })

})
