import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { compareUnicodeCodePoints } from '../../src/contracts/canonical-json.js'
import { serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { buildFromJson } from '../../src/pipeline/build.js'

import { workingTreeSourceModule, type PinnedSourceModule } from './helpers/pinned-source-module.js'

/**
 * Artifact bytes must not depend on the host's collation.
 *
 * The ordering paths that decide artifact bytes -- node and fact ids, labels,
 * hyperedges, durable records, terminal reason counts -- were ordered with
 * `String.prototype.localeCompare`. That comparator asks ICU, and ICU answers
 * according to the process's locale, which Node takes from `LC_ALL`/`LANG` at
 * startup. Two runners with different locales therefore serialized DIFFERENT
 * BYTES for the same graph, which is precisely what the determinism contract
 * says cannot happen.
 *
 * The fixture uses identifiers a real repository can contain. Accented and
 * non-Latin file names are not exotic; they are the ordinary case in which
 * root-locale collation and code-unit order disagree.
 */

/**
 * Ordered so that ICU and code units genuinely disagree.
 *
 * `Ångström` is the discriminator: en-US collates it next to `angle`, sv-SE
 * collates it after `z`, and code-unit order puts it after every ASCII name.
 */
const IDS = [
  'src/Ångström.ts',
  'src/angle.ts',
  'src/Zebra.ts',
  'src/apple.ts',
  'src/café.ts',
  'src/cafe.ts',
  'src/_internal.ts',
  'src/日本.ts',
] as const

const FIXED = {
  repositoryRevision: 'locale-determinism',
  generationMode: 'full',
  generatedAt: '2026-08-25T00:00:00.000Z',
} as const

function extraction(): Record<string, unknown> {
  return {
    schema_version: 2,
    directed: true,
    nodes: IDS.map((id) => ({
      id,
      label: id,
      file_type: 'code',
      source_file: id,
      endpointIdentity: { status: 'stable', reasons: [] },
    })),
    // A chain, so every node participates and every fact id is derived from a
    // pair of these names.
    edges: IDS.slice(1).map((target, index) => ({
      source: IDS[index],
      target,
      relation: 'contains',
      confidence: 'EXTRACTED',
      source_file: IDS[index],
    })),
  }
}

function bytes(): Buffer {
  return serializeGraphArtifactV2({
    graph: buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' }),
    ...FIXED,
  })
}

const digest = (input: Buffer | string): string => createHash('sha256').update(input).digest('hex')

describe('S3-L — the fixture actually discriminates', () => {
  it('is a case where ICU and code-unit order genuinely disagree', () => {
    // Without this the whole file could pass on a fixture that every
    // comparator orders identically, proving nothing at all.
    const byCodeUnit = [...IDS].sort(compareUnicodeCodePoints)
    const bySwedish = [...IDS].sort((left, right) => left.localeCompare(right, 'sv-SE'))
    const byAmerican = [...IDS].sort((left, right) => left.localeCompare(right, 'en-US'))

    expect(bySwedish).not.toEqual(byCodeUnit)
    expect(byAmerican).not.toEqual(byCodeUnit)
    // And the two locales disagree with EACH OTHER, which is the cross-host
    // divergence the artifact was exposed to.
    expect(bySwedish).not.toEqual(byAmerican)
  })
})

describe('S3-L — serialized ordering is code-unit ordering', () => {
  /** The node array exactly as the writer emitted it. */
  function emittedNodeIds(): readonly string[] {
    const text = bytes().toString('utf8')
    const payload = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { nodes: readonly { id: string }[] }
    return payload.nodes.map((node) => node.id)
  }

  it('emits node ids in code-unit order, not collation order', () => {
    // Read from the parsed payload rather than by searching the text: these ids
    // also appear as labels, source files and inside fact attributes, so a
    // first-occurrence scan would measure a different section of the artifact.
    expect(emittedNodeIds()).toEqual([...IDS].sort(compareUnicodeCodePoints))
  })

  it('does not emit the order this host\u2019s collation would produce', () => {
    // The negative half. On a host whose collation happens to agree with code
    // units the assertion above would hold for the wrong reason, so this states
    // the difference explicitly against a locale known to disagree.
    expect(emittedNodeIds()).not.toEqual([...IDS].sort((left, right) => left.localeCompare(right, 'sv-SE')))
    expect(emittedNodeIds()).not.toEqual([...IDS].sort((left, right) => left.localeCompare(right, 'en-US')))
  })

  it('is byte-stable across repeated serialization', () => {
    expect(digest(bytes())).toBe(digest(bytes()))
  })
})

describe('S3-L — the same source under different host locales writes the same bytes', () => {
  /**
   * A process's collation is fixed at startup, so this is the only honest way
   * to test it: transpile today's closure and run it in child processes that
   * were themselves started under different `LC_ALL` values.
   */
  let materialized: PinnedSourceModule | null = null

  afterAll(() => {
    materialized?.dispose()
  })

  function digestUnderLocale(locale: string): string {
    materialized ??= workingTreeSourceModule([
      'src/contracts/graph-artifact.ts',
      'src/pipeline/build.ts',
    ])
    const entry = join(materialized.root, 'locale-probe.mjs')
    writeFileSync(entry, `
import { createHash } from 'node:crypto'
import { serializeGraphArtifactV2 } from './src/contracts/graph-artifact.js'
import { buildFromJson } from './src/pipeline/build.js'
const extraction = ${JSON.stringify(extraction())}
const graph = buildFromJson(extraction, { directed: true, accounting: 'normalized_extraction_boundary' })
const bytes = serializeGraphArtifactV2({ graph, ...${JSON.stringify(FIXED)} })
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`, 'utf8')
    return execFileSync(process.execPath, [entry], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: locale, LANG: locale },
    }).trim()
  }

  it('produces identical bytes under en-US and sv-SE', () => {
    const [americanDigest, americanLocale] = digestUnderLocale('en_US.UTF-8').split(' ')
    const [swedishDigest, swedishLocale] = digestUnderLocale('sv_SE.UTF-8').split(' ')

    // The arms must genuinely have run under different collations, or the
    // comparison is between two identical configurations.
    expect(americanLocale).not.toBe(swedishLocale)
    expect(swedishDigest).toBe(americanDigest)
  })

  it('matches the in-process bytes, so the probe is testing the real writer', () => {
    const [childDigest] = digestUnderLocale('en_US.UTF-8').split(' ')
    expect(childDigest).toBe(digest(bytes()))
  })
})
