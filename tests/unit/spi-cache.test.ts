// SPI cache tests (#77 — v0.16 runtime-efficiency).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpiCached, clearSpiCache } from '../../src/pipeline/spi/cache.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-cache-tests-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

describe('buildSpiCached (#77)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox() })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('builds + persists the cache on first call (no-cache reason on entry)', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const first = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(first.cache.hit).toBe(false)
    expect(first.cache.reason).toBe('no-cache')
    expect(first.spi.files.length).toBeGreaterThan(0)
    expect(first.spi.symbols.find((s) => s.name === 'foo')).toBeTruthy()
  })

  it('returns a cache hit on the second call when content is unchanged', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const first = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(first.cache.hit).toBe(false)

    const second = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(second.cache.hit).toBe(true)
    expect(second.cache.reason).toBe('fresh-cache')
    expect(second.spi.symbols.find((s) => s.name === 'foo')).toBeTruthy()
  })

  it('invalidates the cache when a source file changes', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')
    buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })

    // Modify the file — different content + different mtime.
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 2 }\n')

    const reBuild = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(reBuild.cache.hit).toBe(false)
    // CodeRabbit fix: the actual reason here is key-mismatch (the stale
    // cache exists but the file fingerprint no longer matches), NOT
    // fresh-cache. The earlier assertion was wrong.
    expect(reBuild.cache.reason).toBe('key-mismatch')
  })

  it('invalidates when a new file appears', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')
    buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })

    writeFile(sandbox, 'src/bar.ts', 'export function bar(): number { return 2 }\n')

    const reBuild = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(reBuild.cache.hit).toBe(false)
    expect(reBuild.spi.symbols.find((s) => s.name === 'bar')).toBeTruthy()
  })

  it('invalidates when extractorVersion changes', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', extractorVersion: 'v1', now: FROZEN_NOW })
    const second = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', extractorVersion: 'v2', now: FROZEN_NOW })
    expect(second.cache.hit).toBe(false)
  })

  it('invalidates when tsconfig.json content changes', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')
    writeFile(sandbox, 'tsconfig.json', '{"compilerOptions":{}}\n')

    buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })

    writeFile(sandbox, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const reBuild = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(reBuild.cache.hit).toBe(false)
  })

  it('respects noCache option — never reads or writes the cache', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const first = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(first.cache.hit).toBe(false)

    const second = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', noCache: true, now: FROZEN_NOW })
    expect(second.cache.hit).toBe(false)
    expect(second.cache.reason).toBe('cache-disabled')

    // A third call WITHOUT noCache should still hit the cache from the first build.
    const third = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(third.cache.hit).toBe(true)
  })

  it('clearSpiCache removes persisted artifacts', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(clearSpiCache(sandbox)).toBe(true)

    // A subsequent call should rebuild (no-cache state).
    const reBuild = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(reBuild.cache.hit).toBe(false)
  })

  it('clearSpiCache returns false when no cache exists', () => {
    expect(clearSpiCache(sandbox)).toBe(false)
  })

  it('invokes onCacheLookup with the stats payload', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const captured: Array<{ hit: boolean; reason: string }> = []
    buildSpiCached({
      root: sandbox,
      graphifyVersion: 'test-0.0.0',
      now: FROZEN_NOW,
      onCacheLookup: (stats) => captured.push({ hit: stats.hit, reason: stats.reason }),
    })
    buildSpiCached({
      root: sandbox,
      graphifyVersion: 'test-0.0.0',
      now: FROZEN_NOW,
      onCacheLookup: (stats) => captured.push({ hit: stats.hit, reason: stats.reason }),
    })

    expect(captured.length).toBe(2)
    expect(captured[0]?.hit).toBe(false)
    expect(captured[1]?.hit).toBe(true)
    expect(captured[1]?.reason).toBe('fresh-cache')
  })

  it('produces equivalent SPI output on cache hit vs fresh build', () => {
    writeFile(sandbox, 'src/foo.ts', [
      'export function foo(): number { return 1 }',
      'export function bar(): number { return foo() }',
    ].join('\n') + '\n')

    const fresh = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', noCache: true, now: FROZEN_NOW })
    const cached = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })  // populates cache
    const hit = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })

    expect(hit.cache.hit).toBe(true)
    expect(hit.spi.files.length).toBe(fresh.spi.files.length)
    expect(hit.spi.symbols.length).toBe(fresh.spi.symbols.length)
    expect(hit.spi.edges.length).toBe(fresh.spi.edges.length)
    // The hit's SPI should match the just-built cached one byte-for-byte.
    expect(JSON.stringify(hit.spi)).toBe(JSON.stringify(cached.spi))
  })

  it('handles a corrupt cache index gracefully', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')
    buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })

    // Corrupt the cache index file.
    writeFile(sandbox, 'graphify-out/.spi-cache/index.json', '{ not valid json')

    const reBuild = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(reBuild.cache.hit).toBe(false)
    expect(reBuild.spi.symbols.find((s) => s.name === 'foo')).toBeTruthy()
  })

  it('honours an explicit cacheDir override', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const altCacheDir = join(sandbox, '.alt-cache')
    buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', cacheDir: altCacheDir, now: FROZEN_NOW })

    const second = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', cacheDir: altCacheDir, now: FROZEN_NOW })
    expect(second.cache.hit).toBe(true)

    // A call WITHOUT the override would look in the default location and miss.
    const defaultPath = buildSpiCached({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
    expect(defaultPath.cache.hit).toBe(false)
  })
})
