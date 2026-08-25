import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Guards the one decision that cannot be re-derived from types: which builds own
 * the declared normalized extraction boundary.
 *
 * `buildFromJson` is reachable from compatibility callers as well as real
 * builds, and #658's audit found exactly that -- `serve` reshapes a stored v1
 * artifact's links into extraction shape and passed them straight through,
 * producing a receipt that claimed candidates nothing had extracted. The type
 * system cannot tell those two callers apart, so the allowlist is asserted here
 * and a new opt-in has to be added deliberately rather than by copy-paste.
 */

const SRC = resolve(process.cwd(), 'src')

/**
 * Every production site permitted to opt in, with why it owns the boundary.
 * Adding a row is a reviewed decision; the test fails on any site not listed.
 */
const PERMITTED_OPT_IN = new Map<string, string>([
  ['src/infrastructure/generate.ts', 'full and incremental source generation -- the only real normalized builds'],
])

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

function productionFilesOptingIn(): Map<string, number> {
  const found = new Map<string, number>()
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8')
    // Count opt-ins, not the type declaration that defines the mode.
    const matches = text.match(/accounting:\s*'normalized_extraction_boundary'/g)
    if (matches === null) continue
    found.set(relative(process.cwd(), path).split('\\').join('/'), matches.length)
  }
  return found
}

describe('normalized accounting opt-in is confined to reviewed call sites', () => {
  it('has an allowlist that is not vacuously empty', () => {
    // A guard over an empty set would pass forever while guarding nothing.
    expect(PERMITTED_OPT_IN.size).toBeGreaterThan(0)
  })

  it('finds the opt-ins it expects, so the scan is not silently matching nothing', () => {
    const found = productionFilesOptingIn()
    expect(found.size, 'no production file opts in -- the scan or the pattern drifted').toBeGreaterThan(0)
    expect(found.get('src/infrastructure/generate.ts'), 'generate must own the boundary').toBeGreaterThan(0)
  })

  it('permits no production file outside the allowlist to opt in', () => {
    const unexpected = [...productionFilesOptingIn().keys()]
      .filter((file) => !PERMITTED_OPT_IN.has(file))
      .sort()

    expect(
      unexpected,
      `these files opt into normalized accounting without review: ${unexpected.join(', ')}. `
      + 'A compatibility caller that opts in publishes a receipt claiming candidates it never '
      + 'extracted. Add a row to PERMITTED_OPT_IN only if the site genuinely owns the boundary.',
    ).toEqual([])
  })

  it('keeps the compatibility loader in serve out of the boundary', () => {
    // The exact regression the audit found. Named explicitly so a future edit
    // that re-adds it fails with the reason rather than a generic count.
    const serve = readFileSync(join(SRC, 'runtime', 'serve.ts'), 'utf8')
    expect(
      serve.includes("accounting: 'normalized_extraction_boundary'"),
      'serve rehydrates a stored v1 artifact; it must never claim normalized extraction',
    ).toBe(false)
  })

  it('keeps every accounting mode a declared literal', () => {
    // A computed or variable mode would defeat this whole scan.
    for (const path of sources(SRC)) {
      const text = readFileSync(path, 'utf8')
      const dynamic = text.match(/accounting:\s*(?!'(none|normalized_extraction_boundary)')[A-Za-z_(]/g)
      expect(
        dynamic,
        `${relative(process.cwd(), path)} sets accounting from a non-literal, which this policy cannot audit`,
      ).toBeNull()
    }
  })
})
