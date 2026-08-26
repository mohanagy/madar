import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { compareUnicodeCodePoints } from '../../src/contracts/canonical-json.js'
import { parseIndexingManifest } from '../../src/infrastructure/indexing-manifest.js'
import { createIndexingManifest, shareSafeIndexingManifest } from '../../src/pipeline/indexing-outcomes.js'
import { computeSpiDiffOverlay } from '../../src/pipeline/spi/diff-overlay.js'
import type { SemanticProgramIndex } from '../../src/pipeline/spi/types.js'

import { workingTreeSourceModule, type PinnedSourceModule } from './helpers/pinned-source-module.js'

/**
 * Persisted collection ordering must not depend on the host's collation.
 *
 * `String.prototype.localeCompare` asks ICU, and ICU answers according to the
 * locale Node took from `LC_ALL`/`LANG` at startup. Two machines with different
 * locales therefore wrote DIFFERENT BYTES for the same inputs into
 * `indexing-manifest.json`, into `graph.madar`'s build-freshness provenance and
 * into the SPI diff overlay.
 *
 * Every control here asserts three things, because any one of them alone can be
 * satisfied by a broken implementation:
 *
 *   (a) the fixture actually discriminates -- code-point order differs from
 *       en-US order and from sv-SE order, and those two differ from each other.
 *       Without this the whole file passes on a corpus every comparator sorts
 *       alike, proving nothing.
 *   (b) the emitted order IS code-point order and is NEITHER collation order.
 *       This is the leg a comparator pinned to a fixed locale cannot survive:
 *       `localeCompare(a, b, 'sv-SE')` makes both host arms agree with each
 *       other while still emitting the wrong order.
 *   (c) the published bytes are identical between two child processes started
 *       under different `LC_ALL` values. This is the leg a locale dependency
 *       OUTSIDE the comparator cannot survive.
 *
 * Ordering intended for human reading is deliberately left locale-sensitive;
 * this is not a repository-wide ban on `localeCompare`.
 */

/** Names where ICU collation and code-unit order provably disagree. */
const ADVERSARIAL = [
  'Ångström',
  'angle',
  'Zebra',
  'apple',
  'café',
  'cafe',
  '_internal',
  '日本',
] as const

const PATHS = ADVERSARIAL.map((name) => `src/${name}.ts`)
const FIXED_NOW = new Date('2026-08-25T00:00:00.000Z')

const byEnglish = (values: readonly string[]): string[] =>
  [...values].sort((left, right) => left.localeCompare(right, 'en-US'))
const bySwedish = (values: readonly string[]): string[] =>
  [...values].sort((left, right) => left.localeCompare(right, 'sv-SE'))
const byCodePoint = (values: readonly string[]): string[] =>
  [...values].sort(compareUnicodeCodePoints)

/** Leg (a). A control whose fixture every comparator sorts alike proves nothing. */
function expectFixtureDiscriminates(values: readonly string[], what: string): void {
  expect(byCodePoint(values), `${what}: code-point order equals en-US order`).not.toEqual(byEnglish(values))
  expect(byCodePoint(values), `${what}: code-point order equals sv-SE order`).not.toEqual(bySwedish(values))
  expect(byEnglish(values), `${what}: en-US and sv-SE agree, so the cross-host arm is vacuous`)
    .not.toEqual(bySwedish(values))
}

/** Leg (b). Pins the emitted order to a pure function of the strings. */
function expectCodePointOrder(emitted: readonly string[], inputs: readonly string[], what: string): void {
  expect(emitted, `${what}: not code-point order`).toEqual(byCodePoint(inputs))
  expect(emitted, `${what}: emitted this host's en-US collation order`).not.toEqual(byEnglish(inputs))
  expect(emitted, `${what}: emitted sv-SE collation order`).not.toEqual(bySwedish(inputs))
}

const digest = (input: Buffer | string): string => createHash('sha256').update(input).digest('hex')

// ─────────────────────────────────────────────────────────────────────────────
// Leg (c): run today's source in child processes started under two locales.
// A process's collation is fixed when it starts, so this is the only honest way
// to test it.
// ─────────────────────────────────────────────────────────────────────────────

const materialized = new Map<string, PinnedSourceModule>()

afterAll(() => {
  for (const module of materialized.values()) module.dispose()
  materialized.clear()
})

function moduleFor(entries: readonly string[]): PinnedSourceModule {
  const key = entries.join('|')
  const existing = materialized.get(key)
  if (existing) return existing
  const created = workingTreeSourceModule(entries)
  materialized.set(key, created)
  return created
}

/** Runs `body` inside the materialized tree under `locale`; returns its stdout. */
function runUnderLocale(entries: readonly string[], name: string, body: string, locale: string): string {
  const tree = moduleFor(entries)
  const entryPath = join(tree.root, `${name}.mjs`)
  writeFileSync(entryPath, body, 'utf8')
  return execFileSync(process.execPath, [entryPath], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: locale, LANG: locale },
  }).trim()
}

/**
 * Leg (c) for one writer: identical bytes under en-US and sv-SE.
 *
 * Whether the two arms genuinely resolved to different collations is a property
 * of the host -- Windows ICU follows the system locale and ignores `LC_ALL`, so
 * both arms there are the same configuration. The guarantee does not depend on
 * that: leg (b) already pins the order hermetically. So the byte equality is
 * asserted unconditionally and the divergence only where it is meaningful.
 */
function expectSameBytesAcrossLocales(entries: readonly string[], name: string, body: string): void {
  const [american, americanLocale] = runUnderLocale(entries, name, body, 'en_US.UTF-8').split(' ')
  const [swedish, swedishLocale] = runUnderLocale(entries, name, body, 'sv_SE.UTF-8').split(' ')
  expect(swedish, `${name}: bytes differ between host collations`).toBe(american)
  if (process.platform !== 'win32') {
    expect(americanLocale, `${name}: both arms resolved to the same collator`).not.toBe(swedishLocale)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 -- indexing-manifest.json and its share-safe and failed variants
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST_ENTRIES = [
  'src/pipeline/indexing-outcomes.ts',
  'src/infrastructure/indexing-manifest.ts',
] as const

describe('C1-paths -- manifest outcome ordering', () => {
  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(PATHS, 'outcome paths')
  })

  it('emits outcomes in code-point order, not this host’s collation order', () => {
    const manifest = createIndexingManifest({
      outcomes: PATHS.map((path) => ({
        path, kind: 'file' as const, status: 'indexed' as const,
        reason: 'indexed' as const, capability: null,
      })),
      now: FIXED_NOW,
    })
    expectCodePointOrder(manifest.outcomes.map((outcome) => outcome.path), PATHS, 'manifest outcomes')
  })

  it('writes the same manifest bytes under two host collations', () => {
    expectSameBytesAcrossLocales(MANIFEST_ENTRIES, 'manifest-paths', `
import { createHash } from 'node:crypto'
import { createIndexingManifest } from './src/pipeline/indexing-outcomes.js'
const paths = ${JSON.stringify(PATHS)}
const manifest = createIndexingManifest({
  outcomes: paths.map((path) => ({ path, kind: 'file', status: 'indexed', reason: 'indexed', capability: null })),
  now: new Date(${JSON.stringify(FIXED_NOW.toISOString())}),
})
const bytes = JSON.stringify(manifest, null, 2) + '\\n'
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`)
  })
})

/**
 * `capability` is the case the closed reason/strategy/fallback domains are not:
 * `parseIndexingManifest` accepts ANY string for it, and incremental generation
 * returns a prior outcome verbatim, so whatever a manifest on disk carries comes
 * back and is bucketed. The fixture therefore has to arrive THROUGH the parser,
 * not as a literal -- a control built from literals would still discriminate
 * while no longer exercising the route that makes those values reachable.
 */
const CAPABILITIES = ['Ångström', 'apple', 'Zebra', 'café', 'cafe'] as const

function manifestOnDisk(): Record<string, unknown> {
  return {
    version: 1,
    generated_at: FIXED_NOW.toISOString(),
    summary: {},
    outcomes: CAPABILITIES.map((capability, index) => ({
      path: `src/file-${index}.ts`, kind: 'file', status: 'indexed',
      reason: 'indexed', capability,
    })),
    spi_diagnostics: [],
  }
}

describe('C1-capability -- capability bucket ordering', () => {
  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(CAPABILITIES, 'capability values')
  })

  /**
   * The route and the ordering are asserted together, in one test, on purpose.
   *
   * What makes `capability` an open domain is not the values themselves -- it is
   * that `parseIndexingManifest` accepts any string for it and incremental
   * generation hands a prior outcome straight back. Split across two tests, one
   * could be rewritten to use literals while the other still passed, and the
   * file would keep proving the ordering without proving it on the reachable
   * path. Kept together, dropping the route means visibly deleting it.
   *
   * Note what this cannot do: a fixture built from literals equal to the parser's
   * output would order identically, so no assertion can distinguish them. That
   * is a property of the values being equal by construction, and it is why the
   * parser call is structural here rather than something a control checks.
   */
  it('reaches the sort through parseIndexingManifest and orders by code point', () => {
    const parsed = parseIndexingManifest(manifestOnDisk())
    expect(parsed, 'parseIndexingManifest rejected the fixture; the route is gone').not.toBeNull()
    const fromParser = parsed as NonNullable<typeof parsed>
    expect(
      fromParser.outcomes.map((outcome) => outcome.capability),
      'the parser no longer round-trips these capabilities; the domain may have closed',
    ).toEqual([...CAPABILITIES])

    const manifest = createIndexingManifest({ outcomes: fromParser.outcomes, now: FIXED_NOW })
    expectCodePointOrder(
      Object.keys(manifest.summary.capability_buckets),
      CAPABILITIES,
      'capability_buckets',
    )
  })

  it('writes the same manifest and share-safe bytes under two host collations', () => {
    expectSameBytesAcrossLocales(MANIFEST_ENTRIES, 'manifest-capability', `
import { createHash } from 'node:crypto'
import { parseIndexingManifest } from './src/infrastructure/indexing-manifest.js'
import { createIndexingManifest, shareSafeIndexingManifest } from './src/pipeline/indexing-outcomes.js'
const parsed = parseIndexingManifest(${JSON.stringify(manifestOnDisk())})
if (parsed === null) throw new Error('probe fixture rejected by parseIndexingManifest')
const manifest = createIndexingManifest({ outcomes: parsed.outcomes, now: new Date(${JSON.stringify(FIXED_NOW.toISOString())}) })
const bytes = JSON.stringify(manifest, null, 2) + '\\n'
  + JSON.stringify(shareSafeIndexingManifest(manifest), null, 2) + '\\n'
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`)
  })
})

/**
 * SPI diagnostic ids reach this sort projected verbatim from `result.spi.diagnostics`,
 * and the SPI cache shape-checks only `version`/`workspace`/`files`/`symbols`, so a
 * cached index can carry any id at all.
 */
const DIAGNOSTIC_IDS = ADVERSARIAL.map((name) => `spi.import.unresolved.${name}`)

describe('C1-diagnostics -- spi_diagnostics ordering', () => {
  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(DIAGNOSTIC_IDS, 'spi diagnostic ids')
  })

  it('emits spi_diagnostics in code-point order', () => {
    const manifest = createIndexingManifest({
      outcomes: [],
      spiDiagnostics: DIAGNOSTIC_IDS.map((id) => ({
        id, level: 'info' as const, reason: 'spi_diagnostic' as const,
      })),
      now: FIXED_NOW,
    })
    expectCodePointOrder(
      manifest.spi_diagnostics.map((diagnostic) => diagnostic.id),
      DIAGNOSTIC_IDS,
      'spi_diagnostics',
    )
  })

  it('writes the same manifest bytes under two host collations', () => {
    expectSameBytesAcrossLocales(MANIFEST_ENTRIES, 'manifest-diagnostics', `
import { createHash } from 'node:crypto'
import { createIndexingManifest } from './src/pipeline/indexing-outcomes.js'
const ids = ${JSON.stringify(DIAGNOSTIC_IDS)}
const manifest = createIndexingManifest({
  outcomes: [],
  spiDiagnostics: ids.map((id) => ({ id, level: 'info', reason: 'spi_diagnostic' })),
  now: new Date(${JSON.stringify(FIXED_NOW.toISOString())}),
})
const bytes = JSON.stringify(manifest, null, 2) + '\\n'
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`)
  })
})

describe('C1 -- the share-safe manifest carries only closed-domain summary values', () => {
  it('is byte-stable across repeated serialization', () => {
    const manifest = createIndexingManifest({
      outcomes: PATHS.map((path) => ({
        path, kind: 'file' as const, status: 'indexed' as const,
        reason: 'indexed' as const, capability: 'spi:typescript',
      })),
      now: FIXED_NOW,
    })
    const bytes = (): string => `${JSON.stringify(shareSafeIndexingManifest(manifest), null, 2)}\n`
    expect(digest(bytes())).toBe(digest(bytes()))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 -- graph.madar provenance.graph_build_freshness.git.dirty_files
// ─────────────────────────────────────────────────────────────────────────────

const GRAPH_ENTRIES = [
  'src/contracts/graph-artifact.ts',
  'src/pipeline/build.ts',
  'src/shared/graph-build-freshness.ts',
] as const

const tempRoots: string[] = []
afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

/** A real git repository whose dirty set is exactly `PATHS`. */
function dirtyRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-715-dirty-'))
  tempRoots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'control@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'control'], { cwd: root })
  writeFileSync(join(root, 'seed.txt'), 'seed\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const path of PATHS) writeFileSync(join(root, path), 'export const x = 1\n', 'utf8')
  return root
}

describe('C2 -- graph.madar build-freshness provenance ordering', () => {
  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(PATHS, 'dirty file paths')
  })

  it('orders dirty files by code point, not by this host’s collation', async () => {
    const { buildGraphBuildFreshnessMetadata } = await import('../../src/shared/graph-build-freshness.js')
    const freshness = buildGraphBuildFreshnessMetadata(dirtyRepository(), PATHS)
    expect(freshness.strategy).toBe('git')
    expectCodePointOrder(freshness.git?.dirty_files ?? [], PATHS, 'graph_build_freshness.git.dirty_files')
  })

  it('serializes the same graph.madar bytes under two host collations', () => {
    // The probe builds its own repository so both arms see identical inputs; only
    // the clock is pinned afterwards, never the ordering under test.
    expectSameBytesAcrossLocales(GRAPH_ENTRIES, 'graph-artifact', `
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { serializeGraphArtifactV2 } from './src/contracts/graph-artifact.js'
import { buildFromJson } from './src/pipeline/build.js'
import { buildGraphBuildFreshnessMetadata } from './src/shared/graph-build-freshness.js'

const paths = ${JSON.stringify(PATHS)}
const root = mkdtempSync(join(tmpdir(), 'madar-715-probe-'))
execFileSync('git', ['init', '-q'], { cwd: root })
execFileSync('git', ['config', 'user.email', 'p@example.com'], { cwd: root })
execFileSync('git', ['config', 'user.name', 'p'], { cwd: root })
writeFileSync(join(root, 'seed.txt'), 'seed\\n', 'utf8')
execFileSync('git', ['add', '.'], { cwd: root })
execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })
for (const path of paths) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, 'export const x = 1\\n', 'utf8')
}
const freshness = buildGraphBuildFreshnessMetadata(root, paths)
// Pin only what a clock decides: the wall clock, and the commit sha, which
// differs between the two arms because each builds its own repository and a
// commit's identity includes its timestamp. Ordering -- the property under
// test -- is untouched.
const pinned = {
  ...freshness,
  generated_at: '2026-08-25T00:00:00.000Z',
  generated_ms: 0,
  git: { ...freshness.git, head_sha: 'pinned-head-sha' },
}
const extraction = {
  schema_version: 2,
  directed: true,
  nodes: paths.map((id) => ({ id, label: id, file_type: 'code', source_file: id, endpointIdentity: { status: 'stable', reasons: [] } })),
  edges: paths.slice(1).map((target, index) => ({ source: paths[index], target, relation: 'contains', confidence: 'EXTRACTED', source_file: paths[index] })),
}
const graph = buildFromJson(extraction, { directed: true, accounting: 'normalized_extraction_boundary' })
const bytes = serializeGraphArtifactV2({
  graph,
  repositoryRevision: 'persisted-ordering',
  generationMode: 'full',
  generatedAt: '2026-08-25T00:00:00.000Z',
  provenance: { schema_version: 2, graph_build_freshness: pinned },
})
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`)
  })

  it('leaves a clean worktree with no dirty files to order', async () => {
    // The positive half. Nothing in this change touches a clean build, so the
    // ordering fix must be invisible when there is nothing to order.
    const { buildGraphBuildFreshnessMetadata } = await import('../../src/shared/graph-build-freshness.js')
    const root = mkdtempSync(join(tmpdir(), 'madar-715-clean-'))
    tempRoots.push(root)
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'control@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'control'], { cwd: root })
    writeFileSync(join(root, 'seed.txt'), 'seed\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })

    const freshness = buildGraphBuildFreshnessMetadata(root, [])
    expect(freshness.strategy).toBe('git')
    expect(freshness.git?.dirty_files).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C3 -- SPI diff overlay edges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Symbol ids begin with a per-file hash, so only symbols in the SAME file reach
 * the Unicode tail of the sort key. A fixture with one symbol per file is
 * decided entirely by ASCII hex and proves nothing.
 */
const OVERLAY_FILE_ID = 'file:0123456789abcdef'

function overlaySpi(): SemanticProgramIndex {
  const symbols = ADVERSARIAL.map((name) => ({
    id: `symbol:${OVERLAY_FILE_ID}/function/${name}`,
    file_id: OVERLAY_FILE_ID,
    name,
    kind: 'function' as const,
    range: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
  }))
  return {
    version: 1,
    generated_at: FIXED_NOW.toISOString(),
    workspace: { root: '/repo', fingerprint: 'fp', extractor_version: 'test', madar_version: '0.0.0-test' },
    files: [{ id: OVERLAY_FILE_ID, path: 'src/many.ts', language: 'typescript', loc: 1, hash: 'h' }],
    symbols,
    edges: [],
    diagnostics: [],
  } as unknown as SemanticProgramIndex
}

describe('C3 -- SPI diff overlay edge ordering', () => {
  const overlayKeys = ADVERSARIAL.map(
    (name) => `symbol:${OVERLAY_FILE_ID}/function/${name}|${OVERLAY_FILE_ID}|changed_in`,
  )

  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(overlayKeys, 'overlay edge keys')
  })

  it('orders edges_added by code point', () => {
    const overlay = computeSpiDiffOverlay({
      spi: overlaySpi(),
      root: '/repo',
      baseRef: 'BASE',
      headRef: 'HEAD',
      runGitDiff: () => '+++ src/many.ts\n@@ -1 +1 @@\n',
    })
    expectCodePointOrder(
      overlay.edges_added.map((edge) => `${edge.from}|${edge.to}|${edge.kind}`),
      overlayKeys,
      'overlay edges_added',
    )
  })

  it('produces the same overlay bytes under two host collations', () => {
    expectSameBytesAcrossLocales(['src/pipeline/spi/diff-overlay.ts'], 'diff-overlay', `
import { createHash } from 'node:crypto'
import { computeSpiDiffOverlay } from './src/pipeline/spi/diff-overlay.js'
const spi = ${JSON.stringify(overlaySpi())}
const overlay = computeSpiDiffOverlay({
  spi, root: '/repo', baseRef: 'BASE', headRef: 'HEAD',
  runGitDiff: () => '+++ src/many.ts\\n@@ -1 +1 @@\\n',
})
process.stdout.write(createHash('sha256').update(JSON.stringify(overlay)).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C4 -- proof-report compare-section ordering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * No cross-host arm here, deliberately. `proof-report.ts` reaches the graph
 * runtime, so materializing its closure into a child process would cost far more
 * than it proves: the assertion above already pins the emitted order to a pure
 * function of the strings, which is what a comparator regression breaks.
 */
describe('C4 -- proof report compare-section ordering', () => {
  const compareNames = ADVERSARIAL.map((name) => `compare-${name}`)

  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(compareNames, 'compare directory names')
  })

  it('orders compare summaries by code point', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-715-proof-'))
    tempRoots.push(root)

    const { KnowledgeGraph } = await import('../../src/contracts/graph.js')
    const { toJson } = await import('../../src/pipeline/export.js')
    const graph = new KnowledgeGraph()
    graph.addNode('alpha', { label: 'alpha', source_file: 'src/a.ts', source_location: 'L1', file_type: 'code', community: 0 })
    graph.addNode('beta', { label: 'beta', source_file: 'src/b.ts', source_location: 'L2', file_type: 'code', community: 0 })
    graph.addEdge('alpha', 'beta', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/a.ts' })
    mkdirSync(join(root, 'out'), { recursive: true })
    const graphPath = join(root, 'out', 'graph.json')
    toJson(graph, { 0: ['alpha', 'beta'] }, graphPath)

    // One compare directory per adversarial name, each identifiable by its question.
    for (const name of compareNames) {
      const dir = join(root, 'out', 'compare', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'report.share-safe.json'), JSON.stringify({
        question: `Q ${name}`,
        baseline_mode: 'bounded',
        reduction_ratio: 2,
        status: { baseline: 'completed', madar: 'completed' },
        provider_proof: { winner: 'madar' },
      }, null, 2), 'utf8')
    }

    const { runProofReportCommand } = await import('../../src/infrastructure/proof-report.js')
    const result = runProofReportCommand({
      graphPath,
      // The fixture supplies the path, so the intent is explicit; a default
      // lookup would classify the workspace and hand back a different artifact.
      graphPathIntent: 'explicit',
      outputDir: join(root, 'out', 'proof-report'),
      compareDir: join(root, 'out', 'compare'),
      packPath: null,
    })

    const emitted = compareNames
      .map((name) => ({ name, at: result.report.indexOf(`Q ${name}`) }))
      .filter((entry) => entry.at >= 0)
      .sort((left, right) => left.at - right.at)
      .map((entry) => entry.name)

    expect(emitted, 'no compare questions reached the report; the fixture drifted')
      .toHaveLength(compareNames.length)
    expectCodePointOrder(emitted, compareNames, 'proof-report compare sections')
    expect(readFileSync(result.outputPath, 'utf8')).toBe(result.report)
  })
})
