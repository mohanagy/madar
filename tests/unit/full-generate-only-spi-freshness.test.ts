import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildSpiFresh } from '../../src/pipeline/spi/cache.js'
import { buildSpiCached } from '../../src/pipeline/spi/cache.js'

/**
 * #722 FULL_GENERATE_ONLY_V1.
 *
 * The supported generation corridor must not consume persisted semantic
 * results. A `noCache` boolean threaded through layers is not sufficient:
 * the supported path calls a capability that has no cache reader at all.
 */
const OPTS = { madarVersion: 'test-722', extractorVersion: 'test-722-extractor' }
const POISON = 'POISON_MARKER_full_generate_only_NOT_IN_REPOSITORY'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-722-fgo-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(root, 'src/a.ts'), 'export const alpha = 1\nexport function realSymbol(){return alpha}\n')
  return root
}

function poisonCache(root: string): string {
  const spiPath = join(root, 'out/.spi-cache/spi.json')
  const spi = JSON.parse(readFileSync(spiPath, 'utf8')) as { symbols: Record<string, unknown>[] }
  spi.symbols = [...spi.symbols, { ...spi.symbols[0], id: `spi.symbol.${POISON}`, name: POISON }]
  writeFileSync(spiPath, JSON.stringify(spi))
  return spiPath
}

describe('#722 supported corridor consumes no persisted SPI', () => {
  it('buildSpiFresh never reads a poisoned cache', () => {
    const root = fixture()
    buildSpiCached({ root, ...OPTS })                       // populate a real cache
    expect(existsSync(join(root, 'out/.spi-cache/spi.json'))).toBe(true)
    poisonCache(root)

    const fresh = buildSpiFresh({ root, ...OPTS })
    const names = fresh.symbols.map((s) => s.name)
    expect(names).not.toContain(POISON)
  })

  it('buildSpiFresh produces the same symbols with and without a poisoned cache', () => {
    const clean = fixture()
    const cleanSymbols = buildSpiFresh({ root: clean, ...OPTS }).symbols.map((s) => s.id).sort()

    const poisoned = fixture()
    buildSpiCached({ root: poisoned, ...OPTS })
    poisonCache(poisoned)
    const poisonedSymbols = buildSpiFresh({ root: poisoned, ...OPTS }).symbols.map((s) => s.id).sort()

    expect(poisonedSymbols).toStrictEqual(cleanSymbols)
  })

  it('proves the poison is live: the cached capability DOES serve it', () => {
    // Precondition for the two tests above. Without this, "the marker was
    // absent" could mean the poison was never readable rather than that the
    // fresh capability ignored it.
    const root = fixture()
    buildSpiCached({ root, ...OPTS })
    poisonCache(root)

    const viaCache = buildSpiCached({ root, ...OPTS })
    expect(viaCache.cache.hit).toBe(true)
    expect(viaCache.spi.symbols.map((s) => s.name)).toContain(POISON)
  })
})
